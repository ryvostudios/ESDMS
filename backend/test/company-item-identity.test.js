import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { apiRequest, authHeader } from "./gate-pass-helpers.js";
import { listDuplicateCompanyItemIdentities } from "../src/modules/material-catalog/material-catalog.repository.js";

// Company Item is the GLOBAL physical identity, and previous-purchase price
// comparison keys on the exact company_item_id. The create-time duplicate
// warning used to FILTER OUT exact-name matches, so typing the same name
// twice silently produced two identities and permanently split that item's
// purchase history.

let server;
let users;
let ceo;
let teamLead;
let uomId;

const created = [];

function uniqueName(label) {
  return `Identity ${label} ${crypto.randomBytes(4).toString("hex")}`;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceo = await authHeader(server.baseUrl, "ceo@test.eset.local");
  teamLead = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  uomId = (await pool.query("SELECT id FROM units_of_measure LIMIT 1")).rows[0].id;
});

after(async () => {
  // Company Items are referenced with ON DELETE RESTRICT and are never
  // hard-deleted by the product; the catalog rows this test creates are
  // cleaned up so repeat local runs stay independent.
  if (created.length > 0) {
    await pool.query("DELETE FROM department_material_catalog WHERE company_item_id = ANY($1)", [created]);
    await pool.query("DELETE FROM company_items WHERE id = ANY($1)", [created]);
  }
  await server.close();
  await pool.end();
});

async function addItem(token, name, overrides = {}) {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token,
    body: { defaultUomId: uomId, newItem: { name }, ...overrides },
  });
  const id = response.body?.data?.companyItem?.id;
  if (id) created.push(id);
  return response;
}

test("the same item name cannot create a second Company Item identity", async () => {
  const name = uniqueName("Cement Bag");

  const first = await addItem(teamLead, name);
  assert.equal(first.status, 201);

  const second = await addItem(teamLead, name);
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error.code, "CONFLICT");
  assert.match(second.body.error.message, /already exists as a company item/i);
  // The message must tell the actor what to do instead, not just refuse.
  assert.match(second.body.error.message, /add that item to this department's catalog/i);

  const count = await pool.query(
    "SELECT count(*)::int AS total FROM company_items WHERE name = $1",
    [name],
  );
  assert.equal(count.rows[0].total, 1, "exactly one identity may exist for one name");
});

test("case and whitespace differences are the same identity", async () => {
  const name = uniqueName("Steel Rod");

  assert.equal((await addItem(teamLead, name)).status, 201);

  for (const variant of [name.toUpperCase(), name.toLowerCase(), `  ${name}  `, name.replace(" ", "   ")]) {
    const response = await addItem(teamLead, variant);
    assert.equal(response.status, 409, `"${variant}" must be refused as the same identity`);
  }

  const count = await pool.query(
    `SELECT count(*)::int AS total FROM company_items
     WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1), '\\s+', ' ', 'g'))`,
    [name],
  );
  assert.equal(count.rows[0].total, 1);
});

test("a similar but genuinely different name is still allowed, and warns", async () => {
  // Two distinct materials may legitimately have similar names. Only the
  // exact normalized identity is enforced; similarity stays a warning.
  const base = uniqueName("Cable");
  assert.equal((await addItem(teamLead, base)).status, 201);

  const variant = `${base} Grade A`;
  const response = await addItem(teamLead, variant);

  assert.equal(response.status, 201, "a distinct name must not be blocked");
  assert.ok(
    response.body.meta?.possibleDuplicates?.some((row) => row.name === base),
    "the similar existing item must be surfaced as a warning",
  );
});

test("an exact match is reported by the warning list too, not filtered out of it", async () => {
  // The original defect in one assertion: the exact match was excluded from
  // possibleDuplicates, which is precisely the entry that mattered.
  const name = uniqueName("Valve");
  assert.equal((await addItem(teamLead, name)).status, 201);

  const similar = await addItem(teamLead, `${name} Extended`);
  assert.equal(similar.status, 201);
  assert.ok(
    similar.body.meta.possibleDuplicates.some((row) => row.name === name),
    "an exact-name existing item must appear among possible duplicates for a longer name",
  );
});

test("an archived Company Item still holds its identity — restore, never re-create", async () => {
  const name = uniqueName("Archived Pump");
  const first = await addItem(ceo, name, { departmentId: users.departmentA });
  assert.equal(first.status, 201);
  const itemId = first.body.data.companyItem.id;

  // Remove from the department catalog, then archive the Company Item.
  await pool.query("UPDATE department_material_catalog SET is_active = false WHERE company_item_id = $1", [itemId]);
  const archived = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/company-items/${itemId}`, {
    token: ceo,
    body: { isActive: false },
  });
  assert.equal(archived.status, 200, JSON.stringify(archived.body));

  const recreate = await addItem(ceo, name, { departmentId: users.departmentA });
  assert.equal(recreate.status, 409, "an archived item must not be re-created as a second identity");
  assert.match(recreate.body.error.message, /archived company item/i);
  assert.match(recreate.body.error.message, /restore it/i);
  assert.match(recreate.body.error.message, /purchase history/i);
});

test("renaming an item onto another identity is a clean conflict, not a database error", async () => {
  const first = uniqueName("Rename A");
  const second = uniqueName("Rename B");
  const a = await addItem(ceo, first, { departmentId: users.departmentA });
  await addItem(ceo, second, { departmentId: users.departmentA });

  const response = await apiRequest(
    server.baseUrl,
    "PATCH",
    `/api/v1/material-catalog/company-items/${a.body.data.companyItem.id}`,
    { token: ceo, body: { name: second } },
  );

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.error.code, "CONFLICT");
  assert.ok(!/duplicate key|constraint/i.test(response.body.error.message), "must not leak the database error");

  // Renaming an item to its own current name must still be accepted.
  const unchanged = await apiRequest(
    server.baseUrl,
    "PATCH",
    `/api/v1/material-catalog/company-items/${a.body.data.companyItem.id}`,
    { token: ceo, body: { name: first } },
  );
  assert.equal(unchanged.status, 200);
});

test("the database refuses a duplicate identity even when the service is bypassed", async () => {
  const name = uniqueName("Direct Insert");
  const created1 = await addItem(teamLead, name);
  assert.equal(created1.status, 201);

  for (const variant of [name, name.toUpperCase(), `  ${name}  `]) {
    await assert.rejects(
      pool.query("INSERT INTO company_items (name, created_by_user_id) VALUES ($1, $2)", [variant, users.ceo]),
      (error) => error.code === "23505",
      `direct INSERT of "${variant}" must violate the identity index`,
    );
  }
});

test("the same Company Item can still be shared across departments", async () => {
  // Global identity is the point: one physical item, many department
  // catalogs. Enforcing identity must not have blocked reuse.
  const name = uniqueName("Shared Item");
  const first = await addItem(ceo, name, { departmentId: users.departmentA });
  assert.equal(first.status, 201);
  const itemId = first.body.data.companyItem.id;

  const second = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceo,
    body: { departmentId: users.departmentB, defaultUomId: uomId, companyItemId: itemId },
  });
  assert.equal(second.status, 201, JSON.stringify(second.body));
  assert.equal(second.body.data.company_item_id, itemId, "both departments must reference ONE identity");

  // And the same item still cannot be added twice to one department.
  const repeat = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceo,
    body: { departmentId: users.departmentB, defaultUomId: uomId, companyItemId: itemId },
  });
  assert.equal(repeat.status, 409);
});

test("previous purchase price stays keyed to one company_item_id", async () => {
  // The business consequence of the defect: a duplicate identity makes an
  // item's own purchase history invisible to Procurement. With identity
  // enforced, every catalog entry for one item resolves to the same id.
  const name = uniqueName("Priced Item");
  const first = await addItem(ceo, name, { departmentId: users.departmentA });
  const itemId = first.body.data.companyItem.id;

  await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceo,
    body: { departmentId: users.departmentB, defaultUomId: uomId, companyItemId: itemId },
  });

  const entries = await pool.query(
    "SELECT DISTINCT company_item_id FROM department_material_catalog WHERE company_item_id = $1",
    [itemId],
  );
  assert.equal(entries.rowCount, 1, "one physical item resolves to exactly one price-history key");
});

test("the duplicate identity report finds nothing once identity is enforced", async () => {
  const duplicates = await listDuplicateCompanyItemIdentities();
  assert.deepEqual(
    duplicates,
    [],
    `the identity index makes duplicates unreachable; found: ${JSON.stringify(duplicates)}`,
  );
});
