import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

// --- Self-service (mounted at /me/...) --------------------------------
export const getMyProfile = () => apiClient.get("/me/profile");
export const updateMyPersonalDetails = (body) => apiClient.patch("/me/profile/personal-details", body);
export const addMyEmergencyContact = (body) => apiClient.post("/me/profile/emergency-contacts", body);
export const removeMyEmergencyContact = (id) => apiClient.del(`/me/profile/emergency-contacts/${id}`);
export const setMyFieldValue = (fieldId, value) => apiClient.put(`/me/profile/fields/${fieldId}`, { value });
export const uploadMyPhoto = (formData) => apiClient.post("/me/profile/photo", formData, { isForm: true });
export const getMyPhotoBlob = () => apiClient.getBlob("/me/profile/photo");

export const getMyDocuments = () => apiClient.get("/me/documents");
export const getMyDocumentRequests = () => apiClient.get("/me/documents/requests");
export const uploadMyDocument = (formData) => apiClient.post("/me/documents", formData, { isForm: true });
export const getMyDocumentBlob = (id) => apiClient.getBlob(`/me/documents/${id}/download`);

export const getMyRotation = () => apiClient.get("/me/rotation");
export const getMyLeave = () => apiClient.get("/me/leave");
export const submitMyLeave = (body) => apiClient.post("/me/leave", body);
export const cancelMyLeave = (id) => apiClient.post(`/me/leave/${id}/cancel`, {});

export const getMyContracts = () => apiClient.get("/me/contracts");
export const getMyContractBlob = (id) => apiClient.getBlob(`/me/contracts/${id}/download`);

export const getMyCompensation = () => apiClient.get("/me/compensation/current");

export const listLeaveTypes = () => apiClient.get("/leave-types");
export const createLeaveType = (body) => apiClient.post("/leave-types", body);
export const updateLeaveType = (id, body) => apiClient.patch(`/leave-types/${id}`, body);

// --- HR / management --------------------------------------------------
export const listEmployees = (params = {}) => {
  return apiClient.get(`/employees${buildQuery(params)}`);
};
export const getEmployeeStatusSummary = () => apiClient.get("/employees/status-summary");
export const checkDuplicateEmployees = (body) => apiClient.post("/employees/check-duplicates", body);
export const createEmployee = (body) => apiClient.post("/employees", body);
export const getEmployee = (id) => apiClient.get(`/employees/${id}`);
export const getEmployeeProfile = (id) => apiClient.get(`/employees/${id}/profile`);
export const getEmployeePhotoBlob = (id) => apiClient.getBlob(`/employees/${id}/profile/photo`);
export const getEmployeeAssignments = (id) => apiClient.get(`/employees/${id}/assignments`);
export const transferEmployee = (id, body) => apiClient.post(`/employees/${id}/transfer`, body);
export const changeEmployeeStatus = (id, body) => apiClient.post(`/employees/${id}/status`, body);
export const createEmployeeLogin = (id, body) => apiClient.post(`/employees/${id}/login`, body);
export const resetEmployeeLoginPassword = (id) => apiClient.post(`/employees/${id}/login/reset`, {});

export const listSites = () => apiClient.get("/employees/sites");

// Active selector (Add Employee/transfer dropdowns) — requires an explicit
// target siteId for an all-site actor; a site-scoped actor's own site is
// used regardless (see backend resolveTargetSiteId).
export const listDepartments = (siteId) => apiClient.get(`/departments${buildQuery({ siteId })}`);
export const listDepartmentsManage = () => apiClient.get("/departments/manage");
export const createDepartment = (body) => apiClient.post("/departments", body);
export const updateDepartment = (id, body) => apiClient.patch(`/departments/${id}`, body);
export const archiveDepartment = (id, isActive) => apiClient.patch(`/departments/${id}`, { isActive });

export const listPositions = (siteId) => apiClient.get(`/positions${buildQuery({ siteId })}`);
export const listPositionsManage = () => apiClient.get("/positions/manage");
export const createPosition = (body) => apiClient.post("/positions", body);
export const updatePosition = (id, body) => apiClient.patch(`/positions/${id}`, body);

export const listEmploymentTypes = () => apiClient.get("/employment-types");
export const listEmploymentTypesManage = () => apiClient.get("/employment-types/manage");
export const createEmploymentType = (body) => apiClient.post("/employment-types", body);
export const updateEmploymentType = (id, body) => apiClient.patch(`/employment-types/${id}`, body);

export const getEmployeeCompensationCurrent = (id) => apiClient.get(`/employees/${id}/compensation/current`);
export const getEmployeeCompensationHistory = (id) => apiClient.get(`/employees/${id}/compensation/history`);
export const recordCompensation = (id, body) => apiClient.post(`/employees/${id}/compensation`, body);

export const listEmployeeContracts = (id) => apiClient.get(`/employees/${id}/contracts`);
export const createContractDraft = (id, body) => apiClient.post(`/employees/${id}/contracts`, body);
export const uploadContractFile = (id, contractId, formData) =>
  apiClient.post(`/employees/${id}/contracts/${contractId}/file`, formData, { isForm: true });
export const updateContractDraft = (id, contractId, body) => apiClient.patch(`/employees/${id}/contracts/${contractId}`, body);
export const finalizeContract = (id, contractId) => apiClient.post(`/employees/${id}/contracts/${contractId}/finalize`, {});
export const getContractBlob = (id, contractId) => apiClient.getBlob(`/employees/${id}/contracts/${contractId}/download`);

export const listEmployeeDocuments = (id) => apiClient.get(`/employees/${id}/documents`);
export const uploadEmployeeDocument = (id, formData) => apiClient.post(`/employees/${id}/documents`, formData, { isForm: true });
export const verifyDocument = (id, documentId, body) => apiClient.post(`/employees/${id}/documents/${documentId}/verify`, body);
export const requestDocument = (id, body) => apiClient.post(`/employees/${id}/documents/requests`, body);
export const getDocumentBlob = (id, documentId) => apiClient.getBlob(`/employees/${id}/documents/${documentId}/download`);

export const getEmployeeRotation = (id) => apiClient.get(`/employees/${id}/rotation`);
export const adjustRotation = (id, body) => apiClient.post(`/employees/${id}/rotation/adjust`, body);

export const getEmployeeLeave = (id) => apiClient.get(`/employees/${id}/leave`);
export const listPendingLeave = () => apiClient.get("/leave/pending");
export const decideLeave = (requestId, body) => apiClient.post(`/leave/${requestId}/decide`, body);

// ESDMS-018: the catalog context (SELF vs MANAGEMENT visibility/edit
// rules) is always explicit — never inferred backend-side from whether the
// caller also happens to hold a management permission. Callers must state
// which one they mean; see workforce-config.service.js.
export const listDocumentTypesManage = () => apiClient.get("/workforce-config/document-types?context=management");
export const listDocumentTypesSelf = () => apiClient.get("/workforce-config/document-types?context=self");
export const createDocumentType = (body) => apiClient.post("/workforce-config/document-types", body);
export const updateDocumentType = (id, body) => apiClient.patch(`/workforce-config/document-types/${id}`, body);

export const listProfileSections = () => apiClient.get("/workforce-config/sections");
export const createProfileSection = (body) => apiClient.post("/workforce-config/sections", body);
export const updateProfileSection = (id, body) => apiClient.patch(`/workforce-config/sections/${id}`, body);
export const listCustomFieldsManage = () => apiClient.get("/workforce-config/fields?context=management");
export const listCustomFieldsSelf = () => apiClient.get("/workforce-config/fields?context=self");
export const createCustomField = (body) => apiClient.post("/workforce-config/fields", body);
export const updateCustomField = (id, body) => apiClient.patch(`/workforce-config/fields/${id}`, body);

export const listRotationPolicies = () => apiClient.get("/rotation-policies");
export const createRotationPolicy = (body) => apiClient.post("/rotation-policies", body);
export const updateRotationPolicy = (id, body) => apiClient.patch(`/rotation-policies/${id}`, body);

export const downloadEmployeeMasterReport = () => apiClient.getBlob("/reports/workforce/employee-master.xlsx");
export const getReportCatalog = () => apiClient.get("/reports/workforce/catalog");
export const downloadWorkforceReport = (key, params = {}) => {
  return apiClient.getBlob(`/reports/workforce/${key}.xlsx${buildQuery(params)}`);
};
export const downloadBulkFiles = (body) => apiClient.postBlob("/reports/workforce/bulk-files.zip", body);
export const downloadImportTemplate = () => apiClient.getBlob("/employees/import/template.xlsx");
export const previewEmployeeImport = (formData) => apiClient.post("/employees/import/preview", formData, { isForm: true });
export const confirmEmployeeImport = (formData) => apiClient.post("/employees/import/confirm", formData, { isForm: true });
export const listExpiringDocuments = (withinDays = 30) => apiClient.get(`/documents/expiring${buildQuery({ withinDays })}`);

// Governance
export const listUsers = () => apiClient.get("/users");
export const getUserPermissions = (id) => apiClient.get(`/users/${id}/permissions`);
export const setUserPermission = (id, code, body) => apiClient.put(`/users/${id}/permissions/${encodeURIComponent(code)}`, body);
export const removeUserPermission = (id, code) => apiClient.del(`/users/${id}/permissions/${encodeURIComponent(code)}`);
export const assignUserBundle = (id, code) => apiClient.put(`/users/${id}/bundles/${encodeURIComponent(code)}`, {});
export const removeUserBundle = (id, code) => apiClient.del(`/users/${id}/bundles/${encodeURIComponent(code)}`);
export const changeUserRole = (id, role) => apiClient.patch(`/users/${id}/role`, { role });
export const activateUser = (id) => apiClient.post(`/users/${id}/activate`, {});
export const deactivateUser = (id) => apiClient.post(`/users/${id}/deactivate`, {});
export const regenerateTempPassword = (id) => apiClient.post(`/users/${id}/regenerate-temp-password`, {});

// Business history: an append-only record of what happened to an Employee.
// Entries are never deleted — CEO-only removal marks them removed and keeps
// the row (the database trigger rejects anything else), which is why the list
// distinguishes removed entries rather than hiding them.
export const getEmployeeBusinessHistory = (id) => apiClient.get(`/employees/${id}/history`);
export const getMyBusinessHistory = () => apiClient.get("/me/history");
export const removeBusinessHistoryEntry = (id, entryId, body) =>
  apiClient.post(`/employees/${id}/history/${entryId}/remove`, body);

// Linking an Employee to an account that already exists, instead of creating a
// second login for the same person.
export const linkExistingUserToEmployee = (id, body) => apiClient.post(`/employees/${id}/login/link-existing`, body);

// Every version ever uploaded for one document type. Superseded versions are
// retained, never overwritten, so this is the only way to see the history.
export const getEmployeeDocumentVersions = (id, documentTypeId) =>
  apiClient.get(`/employees/${id}/documents/versions/${documentTypeId}`);
export const getMyDocumentVersions = (documentTypeId) => apiClient.get(`/me/documents/versions/${documentTypeId}`);

// A CURRENT contract's supported lifecycle endings. A finalized contract is
// never rewritten; this records what became of it.
export const transitionContract = (id, contractId, body) =>
  apiClient.post(`/employees/${id}/contracts/${contractId}/transition`, body);
