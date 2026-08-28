// Covers the Material/Demand hotfix: deleting a Demand List that is still an
// untouched DRAFT, and the archive/reactivate lifecycle the catalog UI now
// exposes. Deletion is deliberately the narrowest possible capability —
// everything past SUBMIT keeps its history.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let ceoToken;
let teamLeadToken; // departmentA
let teamLeadOtherDeptToken; // departmentB
let employeeToken; // departmentA, view only
let guardToken;
let hrToken;
let uomId;
let catalogEntryA;
let catalogEntryB;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function addCatalogEntry(token, name) {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token,
    body: { newItem: { name: unique(name) }, defaultUomId: uomId },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.id;
}

async function createDraft(token = teamLeadToken, catalogEntryId = catalogEntryA) {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token,
    body: { lines: [{ catalogEntryId, quantity: 4 }] },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  // The create response is the full detail envelope; the Demand itself is
  // under `demand` (see material-demand.controller.js#create).
  return response.body.data.demand;
}

function del(id, token) {
  return apiRequest(server.baseUrl, "DELETE", `/api/v1/demands/${id}`, { token });
}

before(async () => {
  server = await startTestServer();
  await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  teamLeadOtherDeptToken = await authHeader(server.baseUrl, "teamlead2@test.eset.local");
  employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
  guardToken = await authHeader(server.baseUrl, "guard@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");

  const uom = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", { token: ceoToken });
  uomId = uom.body.data[0].id;
  catalogEntryA = await addCatalogEntry(teamLeadToken, "DraftDeleteA");
  catalogEntryB = await addCatalogEntry(teamLeadOtherDeptToken, "DraftDeleteB");
});

after(async () => {
  await server.close();
  await pool.end();
});

// ---------------------------------------------------------------------
// Deleting a DRAFT
// ---------------------------------------------------------------------

test("the owning department's Team Lead can delete an untouched DRAFT, and its lines go with it", async () => {
  const draft = await createDraft();

  const lines = await pool.query("SELECT id FROM material_demand_lines WHERE demand_id = $1", [draft.id]);
  assert.equal(lines.rowCount, 1, "the draft really had a line to begin with");

  const response = await del(draft.id, teamLeadToken);
  assert.equal(response.status, 204, JSON.stringify(response.body));

  const demand = await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id]);
  assert.equal(demand.rowCount, 0, "the Demand is gone");

  const orphanLines = await pool.query("SELECT id FROM material_demand_lines WHERE demand_id = $1", [draft.id]);
  assert.equal(orphanLines.rowCount, 0, "its lines cascaded away, leaving nothing orphaned");

  const orphanAudit = await pool.query("SELECT id FROM material_demand_audit_log WHERE demand_id = $1", [draft.id]);
  assert.equal(orphanAudit.rowCount, 0, "its row-level audit cascaded away too");

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${draft.id}`, { token: ceoToken });
  assert.equal(detail.status, 404, "and it can no longer be read back");
});

test("a durable governance audit row survives the deletion, carrying identity but not the payload", async () => {
  const draft = await createDraft();
  assert.equal((await del(draft.id, teamLeadToken)).status, 204);

  const audit = await pool.query(
    `SELECT actor_user_id, action, metadata, created_at
     FROM governance_audit_log
     WHERE action = 'DEMAND_DRAFT_DELETED' AND metadata->>'demandId' = $1`,
    [draft.id],
  );
  assert.equal(audit.rowCount, 1, "exactly one governance row records the deletion");

  const row = audit.rows[0];
  assert.ok(row.actor_user_id, "the actor is recorded");
  assert.ok(row.created_at, "the time is recorded");
  assert.equal(row.metadata.demandNumber, draft.demand_number);
  assert.equal(row.metadata.lineCount, 1);
  assert.ok(row.metadata.departmentId);
  assert.ok(row.metadata.departmentName);

  // Identity and size only — no note, no line contents, no quantities.
  const serialized = JSON.stringify(row.metadata);
  assert.ok(!serialized.includes("catalogEntryId"), "no business payload is copied into the audit row");
  assert.ok(!/"lines"/.test(serialized), "no line array is copied into the audit row");

  // governance_audit_log is append-only at the database level.
  await assert.rejects(
    pool.query("DELETE FROM governance_audit_log WHERE metadata->>'demandId' = $1", [draft.id]),
    /append-only|forbid|cannot/i,
    "the surviving evidence cannot itself be deleted",
  );
});

test("the audit row and the delete are one transaction — a failed delete leaves no audit row", async () => {
  const draft = await createDraft();
  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  const rejected = await del(draft.id, teamLeadToken);
  assert.equal(rejected.status, 409);

  const audit = await pool.query(
    "SELECT id FROM governance_audit_log WHERE action = 'DEMAND_DRAFT_DELETED' AND metadata->>'demandId' = $1",
    [draft.id],
  );
  assert.equal(audit.rowCount, 0, "a refused deletion records nothing");

  const still = await pool.query("SELECT status FROM material_demands WHERE id = $1", [draft.id]);
  assert.equal(still.rows[0].status, "PENDING_INITIAL_REVIEW", "and the Demand is untouched");
});

// ---------------------------------------------------------------------
// Non-DRAFT states
// ---------------------------------------------------------------------

test("a submitted Demand cannot be hard-deleted by anyone, including CEO", async () => {
  const draft = await createDraft();
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken })).status, 200);

  for (const [label, token] of [["Team Lead", teamLeadToken], ["CEO", ceoToken]]) {
    const response = await del(draft.id, token);
    assert.equal(response.status, 409, `${label}: ${JSON.stringify(response.body)}`);
    assert.match(response.body.error.message, /Only a DRAFT can be deleted/i);
  }

  const still = await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id]);
  assert.equal(still.rowCount, 1, "the Demand survives every attempt");
});

test("a Demand with downstream history cannot be forced back to DRAFT to make it deletable", async () => {
  const draft = await createDraft();
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken })).status, 200);

  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/reviews`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });

  // Forcing the status back to DRAFT — the exact shape a bug or a bad manual
  // fix could produce — is now refused by the database itself, so the
  // deletable state can never be re-entered. This is strictly stronger than
  // the previous behaviour, where the rollback succeeded and only the
  // service-layer downstream-history check stood between it and deletion.
  await assert.rejects(
    pool.query("UPDATE material_demands SET status = 'DRAFT' WHERE id = $1", [draft.id]),
    /never return to DRAFT/i,
  );

  const still = await pool.query("SELECT id, status FROM material_demands WHERE id = $1", [draft.id]);
  assert.equal(still.rowCount, 1);
  assert.notEqual(still.rows[0].status, "DRAFT", "the rollback left no trace");

  // And the API delete stays refused, on the unchanged status.
  const response = await del(draft.id, ceoToken);
  assert.equal(response.status, 409, JSON.stringify(response.body));
});

// ---------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------

test("a foreign-department Team Lead is refused, and cannot tell the Demand exists", async () => {
  const draft = await createDraft();

  const response = await del(draft.id, teamLeadOtherDeptToken);
  assert.equal(response.status, 404, JSON.stringify(response.body));

  const still = await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id]);
  assert.equal(still.rowCount, 1);
  assert.equal((await del(draft.id, teamLeadToken)).status, 204, "the owner can still delete it");
});

test("roles without demand.delete_draft are denied before any state is read", async () => {
  const draft = await createDraft();

  for (const [label, token] of [["employee", employeeToken], ["guard", guardToken], ["HR", hrToken]]) {
    const response = await del(draft.id, token);
    assert.equal(response.status, 403, `${label}: ${JSON.stringify(response.body)}`);
  }

  const still = await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id]);
  assert.equal(still.rowCount, 1);
});

test("CEO can delete a draft in a department that is not their own", async () => {
  const draft = await createDraft(teamLeadOtherDeptToken, catalogEntryB);
  assert.equal((await del(draft.id, ceoToken)).status, 204, "company-wide authority reaches every department");
});

test("an explicit DENY override beats the role default", async () => {
  const draft = await createDraft();

  const users = await pool.query("SELECT id FROM users WHERE email = $1", ["teamlead@test.eset.local"]);
  const userId = users.rows[0].id;
  const permission = await pool.query("SELECT id FROM permissions WHERE code = 'demand.delete_draft'");
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, reason, granted_by_user_id)
     VALUES ($1, $2, 'DENY', 'test', $1)`,
    [userId, permission.rows[0].id],
  );

  try {
    const deniedToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
    const response = await del(draft.id, deniedToken);
    assert.equal(response.status, 403, JSON.stringify(response.body));
    assert.equal((await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id])).rowCount, 1);
  } finally {
    await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2", [
      userId,
      permission.rows[0].id,
    ]);
  }
});

// ---------------------------------------------------------------------
// Material catalog archive / reactivate (P4-4)
// ---------------------------------------------------------------------

test("a material can be archived and reactivated, and archived rows are excluded by default", async () => {
  const entryId = await addCatalogEntry(teamLeadToken, "ArchiveCycle");

  const archived = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
    token: teamLeadToken,
    body: { isActive: false },
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.body.data.is_active, false);

  const active = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=100", { token: teamLeadToken });
  assert.ok(!active.body.data.some((row) => row.id === entryId), "archived material is not offered by default");

  const all = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?includeInactive=true&pageSize=100", {
    token: teamLeadToken,
  });
  assert.ok(all.body.data.some((row) => row.id === entryId), "includeInactive is how it is found again");

  const restored = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
    token: teamLeadToken,
    body: { isActive: true },
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.body.data.is_active, true);

  const activeAgain = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=100", { token: teamLeadToken });
  assert.ok(activeAgain.body.data.some((row) => row.id === entryId), "and it is selectable again");
});

test("archiving never touches the shared Company Item", async () => {
  const entryId = await addCatalogEntry(teamLeadToken, "ArchiveKeepsItem");
  const before = await pool.query(
    "SELECT company_item_id FROM department_material_catalog WHERE id = $1",
    [entryId],
  );
  const companyItemId = before.rows[0].company_item_id;

  await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
    token: teamLeadToken,
    body: { isActive: false },
  });

  const item = await pool.query("SELECT is_active FROM company_items WHERE id = $1", [companyItemId]);
  assert.equal(item.rowCount, 1, "the Company Item still exists");
  assert.equal(item.rows[0].is_active, true, "and is untouched — archiving is per-department");
});

test("a foreign-department Team Lead cannot archive or reactivate another department's material", async () => {
  const entryId = await addCatalogEntry(teamLeadToken, "ForeignArchive");

  for (const body of [{ isActive: false }, { isActive: true }]) {
    const response = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
      token: teamLeadOtherDeptToken,
      body,
    });
    assert.equal(response.status, 404, JSON.stringify(response.body));
  }

  const unchanged = await pool.query("SELECT is_active FROM department_material_catalog WHERE id = $1", [entryId]);
  assert.equal(unchanged.rows[0].is_active, true);
});

// ---------------------------------------------------------------------
// P4-1: the real API contract the picker relies on
// ---------------------------------------------------------------------

test("the catalog list rejects pageSize above 100 and serves the documented maximum", async () => {
  const tooBig = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=200", { token: teamLeadToken });
  assert.equal(tooBig.status, 400, "the cap the picker used to violate is real");
  assert.deepEqual(tooBig.body.error.details.fieldErrors.pageSize, ["Too big: expected number to be <=100"]);

  const atCap = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=100&page=1", {
    token: teamLeadToken,
  });
  assert.equal(atCap.status, 200, "and 100 is accepted");
  assert.equal(atCap.body.meta.pageSize, 100);
  assert.equal(typeof atCap.body.meta.total, "number", "total is present so a client can page to the end");
});

test("a submitted Demand's audit trail stays immutable, even against direct SQL", async () => {
  const draft = await createDraft();
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken })).status, 200);

  await assert.rejects(
    pool.query("DELETE FROM material_demand_audit_log WHERE demand_id = $1", [draft.id]),
    /append-only/i,
    "narrowing the guard to DRAFT must not have opened submitted history",
  );
  await assert.rejects(
    pool.query("UPDATE material_demand_audit_log SET action = 'SUBMIT' WHERE demand_id = $1", [draft.id]),
    /append-only/i,
    "UPDATE is still refused outright, in every state",
  );

  // A direct SQL delete of the parent is refused by the Demand table's own
  // narrowed guard, before the cascade is ever reached.
  await assert.rejects(
    pool.query("DELETE FROM material_demands WHERE id = $1", [draft.id]),
    /not permitted once the Demand has been submitted/i,
  );
});

test("a DRAFT's audit rows are still not editable — only removable with the draft itself", async () => {
  const draft = await createDraft();
  await assert.rejects(
    pool.query("UPDATE material_demand_audit_log SET action = 'SUBMIT' WHERE demand_id = $1", [draft.id]),
    /append-only/i,
  );
  assert.equal((await del(draft.id, teamLeadToken)).status, 204);
});

// ---------------------------------------------------------------------
// MD-HF-01/02/03 — direct-SQL adversarial coverage.
//
// Every case below bypasses the API entirely and speaks to PostgreSQL on the
// pool, because the finding these replace was precisely that the service
// layer looked correct while the database still permitted the write. Real
// statements, no mocks.
// ---------------------------------------------------------------------

// A DRAFT that reached the database through the ordinary create path, plus a
// direct handle on its audit rows.
async function draftWithAudit() {
  const draft = await createDraft();
  const audit = await pool.query("SELECT id FROM material_demand_audit_log WHERE demand_id = $1", [draft.id]);
  assert.ok(audit.rowCount > 0, "a created draft always has at least one audit row to attack");
  return draft;
}

async function submittedWithAudit() {
  const draft = await draftWithAudit();
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken })).status, 200);
  return draft;
}

async function auditRowCount(demandId) {
  const result = await pool.query("SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1", [demandId]);
  return result.rows[0].n;
}

test("MD-HF-01 — a direct DELETE of a DRAFT's audit rows is refused", async () => {
  const draft = await draftWithAudit();
  const before = await auditRowCount(draft.id);

  // The rejected design allowed exactly this, on the reasoning that the
  // parent was still a DRAFT. Being a DRAFT is not a licence to erase
  // history — only the parent's own deletion is.
  await assert.rejects(
    pool.query("DELETE FROM material_demand_audit_log WHERE demand_id = $1", [draft.id]),
    /append-only/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM material_demand_audit_log WHERE id IN (SELECT id FROM material_demand_audit_log WHERE demand_id = $1 LIMIT 1)", [draft.id]),
    /append-only/i,
    "narrowing the statement to a single row does not help either",
  );

  assert.equal(await auditRowCount(draft.id), before, "no audit row was removed");
});

test("MD-HF-01 — a direct UPDATE of audit rows is refused in every state", async () => {
  const draft = await draftWithAudit();
  await assert.rejects(
    pool.query("UPDATE material_demand_audit_log SET action = 'SUBMIT' WHERE demand_id = $1", [draft.id]),
    /append-only/i,
  );

  const submitted = await submittedWithAudit();
  await assert.rejects(
    pool.query("UPDATE material_demand_audit_log SET metadata = '{}'::jsonb WHERE demand_id = $1", [submitted.id]),
    /append-only/i,
  );
});

test("MD-HF-02 — a submitted Demand cannot be rolled back to DRAFT by direct SQL", async () => {
  const submitted = await submittedWithAudit();

  await assert.rejects(
    pool.query("UPDATE material_demands SET status = 'DRAFT' WHERE id = $1", [submitted.id]),
    /never return to DRAFT/i,
  );

  // Nor by dressing the same write up as a bulk or conditional update.
  await assert.rejects(
    pool.query("UPDATE material_demands SET status = 'DRAFT' WHERE id = $1 AND status <> 'DRAFT'", [submitted.id]),
    /never return to DRAFT/i,
  );

  const row = await pool.query("SELECT status FROM material_demands WHERE id = $1", [submitted.id]);
  assert.notEqual(row.rows[0].status, "DRAFT");
});

test("MD-HF-02 — submitted → forced DRAFT → DELETE in one transaction deletes nothing", async () => {
  const submitted = await submittedWithAudit();
  const before = await auditRowCount(submitted.id);

  // The full attack chain, inside a single transaction so the rollback and
  // the delete would have been atomic and invisible.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await assert.rejects(
      client.query("UPDATE material_demands SET status = 'DRAFT' WHERE id = $1", [submitted.id]),
      /never return to DRAFT/i,
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  const still = await pool.query("SELECT status FROM material_demands WHERE id = $1", [submitted.id]);
  assert.equal(still.rowCount, 1, "the Demand survives");
  assert.notEqual(still.rows[0].status, "DRAFT");
  assert.equal(await auditRowCount(submitted.id), before, "its history survives intact");
});

test("MD-HF-02 — a submitted Demand's parent row cannot be deleted directly", async () => {
  const submitted = await submittedWithAudit();
  await assert.rejects(
    pool.query("DELETE FROM material_demands WHERE id = $1", [submitted.id]),
    /not permitted once the Demand has been submitted/i,
  );
  assert.equal((await pool.query("SELECT id FROM material_demands WHERE id = $1", [submitted.id])).rowCount, 1);
});

test("the ever-left-DRAFT invariant holds across every realistic route back", async () => {
  const submitted = await submittedWithAudit();

  // Every shape that could plausibly restore deletability, one after another.
  for (const [label, sql] of [
    ["plain rollback", "UPDATE material_demands SET status = 'DRAFT' WHERE id = $1"],
    ["rollback via CASE", "UPDATE material_demands SET status = CASE WHEN true THEN 'DRAFT' ELSE status END WHERE id = $1"],
    ["rollback among other columns", "UPDATE material_demands SET revision = revision, status = 'DRAFT' WHERE id = $1"],
  ]) {
    await assert.rejects(pool.query(sql, [submitted.id]), /never return to DRAFT/i, label);
  }

  // Deleting and re-creating it as a DRAFT is not available either: the
  // delete is refused first, so the identity can never be laundered.
  await assert.rejects(
    pool.query("DELETE FROM material_demands WHERE id = $1", [submitted.id]),
    /not permitted once the Demand has been submitted/i,
  );

  const row = await pool.query("SELECT status FROM material_demands WHERE id = $1", [submitted.id]);
  assert.notEqual(row.rows[0].status, "DRAFT", "it never became deletable again");
});

test("legal lifecycle transitions and non-lifecycle DRAFT edits still work", async () => {
  // A DRAFT edit that does not move status at all.
  const draft = await createDraft();
  const edited = await apiRequest(server.baseUrl, "PATCH", `/api/v1/demands/${draft.id}`, {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: catalogEntryA, quantity: 9 }] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  // DRAFT -> submitted -> reviewed: the ordinary forward workflow.
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken })).status, 200);
  const reviewed = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/reviews`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));

  // A legitimate backward transition between two non-DRAFT states is
  // untouched by the rollback guard, which refuses only the DRAFT edge.
  const restored = await pool.query(
    "UPDATE material_demands SET status = 'PENDING_INITIAL_REVIEW' WHERE id = $1 RETURNING status",
    [draft.id],
  );
  assert.equal(restored.rows[0].status, "PENDING_INITIAL_REVIEW");
});

test("a legitimate DRAFT deletion still cascades its own rows and nothing else", async () => {
  const victim = await draftWithAudit();
  const bystander = await submittedWithAudit();
  const bystanderAudit = await auditRowCount(bystander.id);

  assert.equal((await del(victim.id, teamLeadToken)).status, 204);

  assert.equal((await pool.query("SELECT id FROM material_demands WHERE id = $1", [victim.id])).rowCount, 0);
  assert.equal(await auditRowCount(victim.id), 0, "its own audit rows cascaded away with it");
  assert.equal(
    (await pool.query("SELECT id FROM material_demand_lines WHERE demand_id = $1", [victim.id])).rowCount,
    0,
    "its own lines cascaded away with it",
  );

  assert.equal(await auditRowCount(bystander.id), bystanderAudit, "no other Demand's history was touched");
  assert.equal((await pool.query("SELECT id FROM material_demands WHERE id = $1", [bystander.id])).rowCount, 1);

  // The governance record of the deletion outlives the Demand itself.
  const governance = await pool.query(
    "SELECT id FROM governance_audit_log WHERE action = 'DEMAND_DRAFT_DELETED' AND metadata->>'demandId' = $1",
    [victim.id],
  );
  assert.equal(governance.rowCount, 1, "DEMAND_DRAFT_DELETED is durable after a successful delete");
});

// ---------------------------------------------------------------------
// MD-HF-04/05 — persistent delete eligibility.
//
// The upgrade-boundary proof lives in demand-draft-delete-upgrade-boundary
// .test.js, which migrates through the real baseline. These cover the
// lifecycle of eligibility for rows created under the protected schema, and
// the API's behaviour for an ineligible one.
// ---------------------------------------------------------------------

async function eligibility(demandId) {
  const result = await pool.query("SELECT draft_delete_eligible FROM material_demands WHERE id = $1", [demandId]);
  return result.rows[0]?.draft_delete_eligible;
}

test("a Demand created through the API starts eligible and deletes, keeping its governance row", async () => {
  const draft = await createDraft();
  assert.equal(await eligibility(draft.id), true, "a new DRAFT is eligible");

  assert.equal((await del(draft.id, teamLeadToken)).status, 204);

  const governance = await pool.query(
    "SELECT id FROM governance_audit_log WHERE action = 'DEMAND_DRAFT_DELETED' AND metadata->>'demandId' = $1",
    [draft.id],
  );
  assert.equal(governance.rowCount, 1, "DEMAND_DRAFT_DELETED outlives the Demand");
});

test("submitting clears eligibility, and every route back is refused", async () => {
  const draft = await createDraft();
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${draft.id}/submit`, { token: teamLeadToken })).status, 200);
  assert.equal(await eligibility(draft.id), false, "leaving DRAFT clears eligibility permanently");

  await assert.rejects(
    pool.query("UPDATE material_demands SET status = 'DRAFT' WHERE id = $1", [draft.id]),
    /never return to DRAFT/i,
    "status rollback",
  );
  await assert.rejects(
    pool.query("UPDATE material_demands SET draft_delete_eligible = true WHERE id = $1", [draft.id]),
    /never be restored/i,
    "eligibility reset",
  );
  await assert.rejects(
    pool.query("DELETE FROM material_demands WHERE id = $1", [draft.id]),
    /not permitted once the Demand has been submitted/i,
    "direct parent delete",
  );

  const api = await del(draft.id, ceoToken);
  assert.equal(api.status, 409, JSON.stringify(api.body));

  assert.equal((await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id])).rowCount, 1);
});

test("an ineligible DRAFT is refused by the API cleanly, without a false governance row", async () => {
  const draft = await createDraft();
  // Clearing eligibility is always permitted (only restoring it is not), so
  // this reproduces a legacy row's state on a Demand the suite owns.
  await pool.query("UPDATE material_demands SET draft_delete_eligible = false WHERE id = $1", [draft.id]);

  const response = await del(draft.id, teamLeadToken);
  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.match(response.body.error.message, /not eligible for deletion/i);
  assert.doesNotMatch(response.body.error.message, /migration|eligible column|draft_delete_eligible/i, "no internals leak");

  assert.equal((await pool.query("SELECT id FROM material_demands WHERE id = $1", [draft.id])).rowCount, 1);
  const governance = await pool.query(
    "SELECT id FROM governance_audit_log WHERE action = 'DEMAND_DRAFT_DELETED' AND metadata->>'demandId' = $1",
    [draft.id],
  );
  assert.equal(governance.rowCount, 0, "a refused delete records no deletion event");

  // The DB refuses it independently of the service.
  await assert.rejects(
    pool.query("DELETE FROM material_demands WHERE id = $1", [draft.id]),
    /not eligible for draft deletion/i,
  );
});

test("the API never lets a client set its own eligibility", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: catalogEntryA, quantity: 2 }], draft_delete_eligible: true, draftDeleteEligible: true },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));

  // Accepted only because the field is ignored outright; the value still
  // comes from the database's own INSERT trigger.
  assert.equal(await eligibility(response.body.data.demand.id), true);

  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${response.body.data.demand.id}/submit`, { token: teamLeadToken });
  assert.equal(submitted.status, 200);
  assert.equal(await eligibility(response.body.data.demand.id), false);
});

test("the detail endpoint exposes eligibility so the UI never has to infer it", async () => {
  const draft = await createDraft();
  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${draft.id}`, { token: teamLeadToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.demand.draft_delete_eligible, true);
});
