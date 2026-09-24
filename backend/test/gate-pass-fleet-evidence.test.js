import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload, buildMultiPhotoForm } from "./gate-pass-helpers.js";
import * as gatePassService from "../src/modules/gate-pass/gate-pass.service.js";
import { recordLayout } from "./pdf-layout-recorder.js";

let server;
let users;
let tokens;
let driverId;
let vehicleId;
let vehicleRegistration;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteGuard: await authHeader(server.baseUrl, "guard-othersite@test.eset.local"),
  };

  const driver = await apiRequest(server.baseUrl, "POST", "/api/v1/drivers", {
    token: tokens.admin,
    body: { name: "Master Driver", phone: "+923009999999", company: "Acme" },
  });
  assert.equal(driver.status, 201, JSON.stringify(driver.body));
  driverId = driver.body.data.id;

  vehicleRegistration = unique("GP-REG");
  const vehicle = await apiRequest(server.baseUrl, "POST", "/api/v1/vehicles", {
    token: tokens.admin,
    body: { registrationNumber: vehicleRegistration, vehicleType: "TRUCK" },
  });
  assert.equal(vehicle.status, 201, JSON.stringify(vehicle.body));
  vehicleId = vehicle.body.data.id;
});

after(async () => {
  await server.close();
  await pool.end();
});

async function approvedPass(overrides = {}) {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, ...overrides }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const approved = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${created.body.data.id}/approve`, {
    token: tokens.admin,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return created.body.data.id;
}

test("selecting a Driver and Vehicle snapshots their details onto the Gate Pass", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({
      issuingDepartmentId: users.departmentA,
      driverId,
      vehicleId,
      // Deliberately contradictory free text: the master row must win, so a
      // client cannot claim one driver while selecting another.
      driverName: "Client Supplied Name",
      driverPhone: "+920000000000",
      vehicleRegistration: "CLIENT-SUPPLIED",
    }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${created.body.data.id}`, {
    token: tokens.teamLead,
  });
  assert.equal(detail.body.data.driverName, "Master Driver");
  assert.equal(detail.body.data.driverPhone, "+923009999999");
  assert.equal(detail.body.data.vehicleRegistration, vehicleRegistration);

  // Editing the master row afterwards must NOT rewrite the issued Gate Pass.
  const renamed = await apiRequest(server.baseUrl, "PATCH", `/api/v1/drivers/${driverId}`, {
    token: tokens.admin,
    body: { name: "Renamed After Issue" },
  });
  assert.equal(renamed.status, 200);

  const afterRename = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${created.body.data.id}`, {
    token: tokens.teamLead,
  });
  assert.equal(
    afterRename.body.data.driverName,
    "Master Driver",
    "an issued Gate Pass is history and must not follow later master-data edits",
  );

  // Restore for the remaining tests.
  await apiRequest(server.baseUrl, "PATCH", `/api/v1/drivers/${driverId}`, {
    token: tokens.admin,
    body: { name: "Master Driver" },
  });
});

test("an inactive Driver or Vehicle cannot be attached to a new Gate Pass", async () => {
  const parked = await apiRequest(server.baseUrl, "POST", "/api/v1/vehicles", {
    token: tokens.admin,
    body: { registrationNumber: unique("PARKED") },
  });
  assert.equal(parked.status, 201);
  await apiRequest(server.baseUrl, "PATCH", `/api/v1/vehicles/${parked.body.data.id}`, {
    token: tokens.admin,
    body: { isActive: false },
  });

  const rejected = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, vehicleId: parked.body.data.id }),
  });
  assert.equal(rejected.status, 400);
});

test("a Gate Pass must identify a driver and a vehicle somehow", async () => {
  const missing = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: {
      issuingDepartmentId: users.departmentA,
      requestedBy: "Team Lead",
      destination: "Nowhere",
      purpose: "SAMPLE",
      items: [{ description: "Thing", quantity: 1 }],
    },
  });
  assert.equal(missing.status, 400);
});

test("Guard captures multiple outbound and multiple inbound photos", async () => {
  const id = await approvedPass();

  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 1000 }, 3),
  });
  assert.equal(exit.status, 200, JSON.stringify(exit.body));
  assert.equal(exit.body.data.photoCount, 3);

  const returned = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/return`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 1100 }, 2),
  });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.data.photoCount, 2);

  const evidence = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.guard,
  });
  assert.equal(evidence.status, 200);
  assert.equal(evidence.body.data.filter((row) => row.file_type === "DEPARTURE_PHOTO").length, 3);
  assert.equal(evidence.body.data.filter((row) => row.file_type === "RETURN_PHOTO").length, 2);

  // Metadata only: a listing must never hand out storage keys.
  for (const row of evidence.body.data) {
    assert.equal(row.storage_key, undefined, "evidence listings must not expose storage keys");
  }
});

test("inbound evidence may document something never listed on the approved pass", async () => {
  const id = await approvedPass();

  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 10 }, 1),
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/return`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 20 }, 1),
  });

  const before = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, { token: tokens.teamLead });
  const approvedItemCount = before.body.data.items.length;

  const additional = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ kind: "INBOUND_ADDITIONAL", note: "Unlisted drum returned on the truck bed" }, 2),
  });
  assert.equal(additional.status, 201, JSON.stringify(additional.body));

  // Accepted as evidence — and the approved item list is untouched.
  const after = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, { token: tokens.teamLead });
  assert.equal(after.body.data.items.length, approvedItemCount, "approved items must never be rewritten");
  assert.equal(after.body.data.status, "COMPLETED");

  const evidence = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.guard,
  });
  const extra = evidence.body.data.filter((row) => row.file_type === "RETURN_ADDITIONAL_PHOTO");
  assert.equal(extra.length, 2);
  assert.equal(extra[0].evidence_note, "Unlisted drum returned on the truck bed");

  // Unexplained additional evidence is refused: an unlabelled photo of an
  // unlisted object is not usable evidence later.
  const unexplained = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ kind: "INBOUND_ADDITIONAL" }, 1),
  });
  assert.equal(unexplained.status, 400);
});

test("gate evidence is site-scoped and never publicly reachable", async () => {
  const id = await approvedPass();
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 5 }, 1),
  });

  const evidence = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.guard,
  });
  const fileId = evidence.body.data[0].id;

  // Unauthenticated retrieval is impossible — there is no public URL.
  const anonymous = await fetch(`${server.baseUrl}/api/v1/gate-passes/${id}/files/${fileId}`);
  assert.equal(anonymous.status, 401);

  // Another site's Guard cannot read the bytes or even confirm they exist.
  const crossSite = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}/files/${fileId}`, {
    token: tokens.otherSiteGuard,
  });
  assert.equal(crossSite.status, 404);

  const crossSiteList = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.otherSiteGuard,
  });
  assert.equal(crossSiteList.status, 404);

  // IDOR: a file id belonging to a DIFFERENT Gate Pass is not served just
  // because the caller can reach this one.
  const otherId = await approvedPass();
  const mismatched = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${otherId}/files/${fileId}`, {
    token: tokens.guard,
  });
  assert.equal(mismatched.status, 404);
});

test("completion produces a closure PDF and queues WhatsApp without gating completion", async () => {
  const id = await approvedPass();

  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 100 }, 2),
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/return`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 180 }, 2),
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/evidence`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ kind: "INBOUND_ADDITIONAL", note: "Spare tyre not on the pass" }, 1),
  });

  // Completion is already committed before the document job runs.
  const completed = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, { token: tokens.teamLead });
  assert.equal(completed.body.data.status, "COMPLETED");

  const job = await pool.query(
    `SELECT id, entity_id, payload FROM notification_outbox
     WHERE entity_id = $1 AND event_type = 'GENERATE_COMPLETION_PDF'`,
    [id],
  );
  assert.equal(job.rowCount, 1, "completion enqueues exactly one durable document job");

  await gatePassService.processCompletionPdfJob(job.rows[0]);

  // Fetched directly rather than through apiRequest: this response is binary,
  // and apiRequest already consumes the body trying to parse JSON.
  const pdf = await fetch(`${server.baseUrl}/api/v1/gate-passes/${id}/completion-pdf`, {
    headers: { Cookie: tokens.teamLead },
  });
  assert.equal(pdf.status, 200);
  const bytes = Buffer.from(await pdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 4).toString(), "%PDF", "a real PDF is served");
  assert.ok(bytes.length > 1000, "the completion PDF carries the evidence sections");

  const delivery = await pool.query(
    `SELECT channel, recipient_phone, payload FROM notification_outbox
     WHERE entity_id = $1 AND event_type = 'GATE_PASS_COMPLETED' AND channel = 'WHATSAPP'`,
    [id],
  );
  assert.equal(delivery.rowCount, 1);
  assert.match(delivery.rows[0].payload.filename, /-completion\.pdf$/);

  // Re-running the job is a no-op, not a second document or a second message.
  await gatePassService.processCompletionPdfJob(job.rows[0]);
  const afterRetry = await pool.query(
    `SELECT count(*)::int AS total FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'COMPLETED_PDF'`,
    [id],
  );
  assert.equal(afterRetry.rows[0].total, 1, "the completion PDF job is idempotent");
});

test("a Gate Pass with zero material items runs the full lifecycle and both PDFs say so", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, items: [] }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;

  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/submit`, { token: tokens.teamLead });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const approved = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/approve`, { token: tokens.admin });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));

  const approvalJob = await pool.query(
    "SELECT * FROM notification_outbox WHERE entity_id = $1 AND event_type = 'GENERATE_APPROVAL_PDF'",
    [id],
  );
  let layout = recordLayout();
  try {
    await gatePassService.processApprovalPdfJob(approvalJob.rows[0]);
  } finally {
    layout.restore();
  }
  assert.ok(layout.boxes.some((box) => box.text === "No material items"));
  assert.deepEqual(layout.overlaps(), []);

  // Odometer and evidence remain mandatory: zero items does not relax them.
  const noPhoto = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: tokens.guard,
    body: { odometer: 42150 },
  });
  assert.equal(noPhoto.status, 400);

  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 42150 }, 1),
  });
  assert.equal(exit.status, 200, JSON.stringify(exit.body));
  // Zero-distance trip: returned with the same reading it left with.
  const returned = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/return`, {
    token: tokens.guard,
    isForm: true,
    body: buildMultiPhotoForm({ odometer: 42150 }, 1),
  });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, { token: tokens.teamLead });
  assert.equal(detail.body.data.status, "COMPLETED");
  assert.deepEqual(detail.body.data.items, []);
  assert.equal(detail.body.data.distanceKm, 0);

  const completionJob = await pool.query(
    "SELECT * FROM notification_outbox WHERE entity_id = $1 AND event_type = 'GENERATE_COMPLETION_PDF'",
    [id],
  );
  layout = recordLayout();
  try {
    await gatePassService.processCompletionPdfJob(completionJob.rows[0]);
  } finally {
    layout.restore();
  }
  const drawn = layout.boxes.map((box) => box.text);
  assert.ok(drawn.includes("No material items"));
  assert.ok(drawn.includes("42,150 km"));
  // The printed distance is the stored generated column, not a recomputation.
  assert.equal(drawn[drawn.indexOf("Distance Travelled") + 1], `${detail.body.data.distanceKm} km`);
  assert.deepEqual(layout.overlaps(), []);
});

test("zero items does not bypass any other create or draft-edit validation", async () => {
  const noDriver = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, items: [], driverName: undefined, driverPhone: undefined }),
  });
  assert.equal(noDriver.status, 400);

  const badItem = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, items: [{ description: "Pump", quantity: 0 }] }),
  });
  assert.equal(badItem.status, 400);

  const missingItems = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, items: undefined }),
  });
  assert.equal(missingItems.status, 400, "the items list itself is still required, even if empty");

  // A draft can drop its last item, and the stored item history of other
  // passes is untouched.
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });
  const id = created.body.data.id;
  const edited = await apiRequest(server.baseUrl, "PATCH", `/api/v1/gate-passes/${id}`, {
    token: tokens.teamLead,
    body: { items: [] },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, { token: tokens.teamLead });
  assert.deepEqual(detail.body.data.items, []);
});
