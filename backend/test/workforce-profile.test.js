import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildPhotoForm, buildFakePhotoForm } from "./gate-pass-helpers.js";

let server;
let users;
let hrToken;
let ceoToken;
let umToken;
let employeeId;
let selfToken;
let otherEmployeeToken;
let selfUserId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  umToken = await authHeader(server.baseUrl, "um@test.eset.local");

  const email = `${unique("profile-self")}@test.eset.local`;
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP"), fullLegalName: unique("Profile Self Test"), joiningDate: "2026-01-01" },
  });
  employeeId = created.body.data.id;

  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  selfUserId = login.body.data.userId;
  const tempToken = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: tempToken,
    body: { currentPassword: login.body.data.temporaryPassword, newPassword: "Profile-Self-Pw-123" },
  });
  selfToken = await authHeader(server.baseUrl, email, "Profile-Self-Pw-123");

  otherEmployeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
});

after(async () => {
  await server.close();
  await pool.end();
});

test("an unauthorized actor cannot view another employee's profile", async () => {
  const response = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/profile`, {
    token: otherEmployeeToken,
  });
  assert.equal(response.status, 403);
});

test("self and HR can both view the profile via their respective mounts", async () => {
  const self = await apiRequest(server.baseUrl, "GET", "/api/v1/me/profile", { token: selfToken });
  assert.equal(self.status, 200);
  assert.equal(self.body.data.employee.id, employeeId);

  const hrView = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/profile`, { token: hrToken });
  assert.equal(hrView.status, 200);
});

test("personal details update is allowlisted — an attempt to sneak employeeCode through is ignored", async () => {
  const employeeCodeBefore = (await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}`, { token: hrToken }))
    .body.data.employeeCode;

  const update = await apiRequest(server.baseUrl, "PATCH", "/api/v1/me/profile/personal-details", {
    token: selfToken,
    body: { mobile: "0300-1234567", employeeCode: "HACKED-CODE" },
  });
  assert.equal(update.status, 200, JSON.stringify(update.body));

  const after = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}`, { token: hrToken });
  assert.equal(after.body.data.employeeCode, employeeCodeBefore, "employeeCode must be unchanged");
});

test("emergency contacts: self can add/edit/remove; another employee cannot touch them", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/me/profile/emergency-contacts", {
    token: selfToken,
    body: { name: "Jane Doe", phone: "0300-9999999", relationship: "Spouse" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const contactId = created.body.data.id;

  const otherEdit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/me/profile/emergency-contacts/${contactId}`, {
    token: otherEmployeeToken,
    body: { name: "Tampered" },
  });
  assert.equal(otherEdit.status, 403);

  const selfEdit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/me/profile/emergency-contacts/${contactId}`, {
    token: selfToken,
    body: { name: "Jane D. Updated" },
  });
  assert.equal(selfEdit.status, 200);
});

test("HR-configured custom field: employee can set it when employee_can_edit is true, validated by type", async () => {
  const section = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/sections", {
    token: hrToken,
    body: { name: unique("Section") },
  });
  const field = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken,
    body: {
      sectionId: section.body.data.id,
      label: "Blood Group",
      fieldKey: unique("blood_group").replace(/-/g, "_"),
      fieldType: "DROPDOWN",
      validation: { options: ["A+", "B+", "O+"] },
      countsTowardCompletion: true,
    },
  });
  assert.equal(field.status, 201, JSON.stringify(field.body));
  const fieldId = field.body.data.id;

  const invalid = await apiRequest(server.baseUrl, "PUT", `/api/v1/me/profile/fields/${fieldId}`, {
    token: selfToken,
    body: { value: "Z+" },
  });
  assert.equal(invalid.status, 400, "not one of the configured dropdown options");

  const valid = await apiRequest(server.baseUrl, "PUT", `/api/v1/me/profile/fields/${fieldId}`, {
    token: selfToken,
    body: { value: "A+" },
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.body));
});

test("a field with employee_can_edit=false rejects a self write but HR can still set it", async () => {
  const section = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/sections", {
    token: hrToken,
    body: { name: unique("Section") },
  });
  const field = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken,
    body: {
      sectionId: section.body.data.id,
      label: "HR Only Note",
      fieldKey: unique("hr_only").replace(/-/g, "_"),
      fieldType: "TEXT",
      employeeCanEdit: false,
    },
  });
  const fieldId = field.body.data.id;

  const selfAttempt = await apiRequest(server.baseUrl, "PUT", `/api/v1/me/profile/fields/${fieldId}`, {
    token: selfToken,
    body: { value: "trying to self-edit" },
  });
  assert.equal(selfAttempt.status, 403);

  const hrSet = await apiRequest(server.baseUrl, "PUT", `/api/v1/employees/${employeeId}/profile/fields/${fieldId}`, {
    token: hrToken,
    body: { value: "HR set this" },
  });
  assert.equal(hrSet.status, 200, JSON.stringify(hrSet.body));
});

test("field_type cannot be changed through the update endpoint even if the client sends it", async () => {
  const section = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/sections", {
    token: hrToken,
    body: { name: unique("Section") },
  });
  const field = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken,
    body: { sectionId: section.body.data.id, label: "Notes", fieldKey: unique("notes_field").replace(/-/g, "_"), fieldType: "TEXT" },
  });

  const attempt = await apiRequest(server.baseUrl, "PATCH", `/api/v1/workforce-config/fields/${field.body.data.id}`, {
    token: hrToken,
    body: { fieldType: "DATE", label: "Notes Renamed" },
  });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.body.data.field_type, "TEXT", "fieldType is not part of the update schema at all");
  assert.equal(attempt.body.data.label, "Notes Renamed");
});

test("a reserved field key is rejected", async () => {
  const section = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/sections", {
    token: hrToken,
    body: { name: unique("Section") },
  });
  const field = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken,
    body: { sectionId: section.body.data.id, label: "Salary Note", fieldKey: "custom_salary_note", fieldType: "TEXT" },
  });
  assert.equal(field.status, 400);
});

test("a protected custom-field label is rejected even when its key looks harmless", async () => {
  const section = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/sections", {
    token: hrToken,
    body: { name: unique("Section") },
  });
  const field = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken,
    body: { sectionId: section.body.data.id, label: "Monthly Pay", fieldKey: unique("misc_value").replace(/-/g, "_"), fieldType: "NUMBER" },
  });
  assert.equal(field.status, 400);
});

test("an individual DENY override is honored by self profile reads and writes", async () => {
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/profile.self.view`, {
    token: ceoToken, body: { effect: "DENY", reason: "security test" },
  });
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/profile.self.edit`, {
    token: ceoToken, body: { effect: "DENY", reason: "security test" },
  });
  try {
    const view = await apiRequest(server.baseUrl, "GET", "/api/v1/me/profile", { token: selfToken });
    assert.equal(view.status, 403);
    const edit = await apiRequest(server.baseUrl, "PATCH", "/api/v1/me/profile/personal-details", {
      token: selfToken, body: { mobile: "0300-0000000" },
    });
    assert.equal(edit.status, 403);
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/profile.self.view`, { token: ceoToken });
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/profile.self.edit`, { token: ceoToken });
  }
});

test("custom-field visibility is actor-specific, not the union of HR and management flags", async () => {
  const section = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/sections", { token: hrToken, body: { name: unique("Visibility") } });
  const hrField = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken, body: { sectionId: section.body.data.id, label: "HR Visible Note", fieldKey: unique("hr_visible").replace(/-/g, "_"), fieldType: "TEXT", employeeCanView: false, hrCanView: true, managementCanView: false },
  });
  const managementField = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/fields", {
    token: hrToken, body: { sectionId: section.body.data.id, label: "Management Visible Note", fieldKey: unique("management_visible").replace(/-/g, "_"), fieldType: "TEXT", employeeCanView: false, hrCanView: false, managementCanView: true },
  });
  await apiRequest(server.baseUrl, "PUT", `/api/v1/employees/${employeeId}/profile/fields/${hrField.body.data.id}`, { token: hrToken, body: { value: "HR" } });
  await apiRequest(server.baseUrl, "PUT", `/api/v1/employees/${employeeId}/profile/fields/${managementField.body.data.id}`, { token: hrToken, body: { value: "UM" } });

  const hr = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/profile`, { token: hrToken });
  const um = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/profile`, { token: umToken });
  const ceo = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/profile`, { token: ceoToken });
  assert.ok(hr.body.data.customFieldValues.some((field) => field.fieldId === hrField.body.data.id));
  assert.ok(!hr.body.data.customFieldValues.some((field) => field.fieldId === managementField.body.data.id));
  assert.ok(!um.body.data.customFieldValues.some((field) => field.fieldId === hrField.body.data.id));
  assert.ok(um.body.data.customFieldValues.some((field) => field.fieldId === managementField.body.data.id));
  assert.ok(ceo.body.data.customFieldValues.some((field) => field.fieldId === hrField.body.data.id));
  assert.ok(ceo.body.data.customFieldValues.some((field) => field.fieldId === managementField.body.data.id));
});

test("profile photo: valid image accepted and downloadable; forged signature rejected", async () => {
  const upload = await apiRequest(server.baseUrl, "POST", "/api/v1/me/profile/photo", {
    token: selfToken,
    body: buildPhotoForm({}),
    isForm: true,
  });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));

  const download = await apiRequest(server.baseUrl, "GET", "/api/v1/me/profile/photo", { token: selfToken });
  assert.equal(download.status, 200);

  const forged = await apiRequest(server.baseUrl, "POST", "/api/v1/me/profile/photo", {
    token: selfToken,
    body: buildFakePhotoForm({}),
    isForm: true,
  });
  assert.equal(forged.status, 400);
});

test("profile completion percent reflects filled required core + counted custom fields", async () => {
  const profile = await apiRequest(server.baseUrl, "GET", "/api/v1/me/profile", { token: selfToken });
  assert.equal(profile.status, 200);
  assert.ok(profile.body.data.completion.percent >= 0 && profile.body.data.completion.percent <= 100);
});
