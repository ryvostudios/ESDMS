import { apiClient } from "../../core/api/client.js";

// --- Self-service (mounted at /me/...) --------------------------------
export const getMyProfile = () => apiClient.get("/me/profile");
export const updateMyPersonalDetails = (body) => apiClient.patch("/me/profile/personal-details", body);
export const addMyEmergencyContact = (body) => apiClient.post("/me/profile/emergency-contacts", body);
export const removeMyEmergencyContact = (id) => apiClient.del(`/me/profile/emergency-contacts/${id}`);
export const setMyFieldValue = (fieldId, value) => apiClient.put(`/me/profile/fields/${fieldId}`, { value });
export const uploadMyPhoto = (formData) => apiClient.post("/me/profile/photo", formData, { isForm: true });

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
  const query = new URLSearchParams(params).toString();
  return apiClient.get(`/employees${query ? `?${query}` : ""}`);
};
export const checkDuplicateEmployees = (body) => apiClient.post("/employees/check-duplicates", body);
export const createEmployee = (body) => apiClient.post("/employees", body);
export const getEmployee = (id) => apiClient.get(`/employees/${id}`);
export const getEmployeeProfile = (id) => apiClient.get(`/employees/${id}/profile`);
export const getEmployeeAssignments = (id) => apiClient.get(`/employees/${id}/assignments`);
export const transferEmployee = (id, body) => apiClient.post(`/employees/${id}/transfer`, body);
export const changeEmployeeStatus = (id, body) => apiClient.post(`/employees/${id}/status`, body);
export const createEmployeeLogin = (id, body) => apiClient.post(`/employees/${id}/login`, body);
export const resetEmployeeLoginPassword = (id) => apiClient.post(`/employees/${id}/login/reset`, {});

export const listDepartmentsManage = () => apiClient.get("/departments/manage");
export const createDepartment = (body) => apiClient.post("/departments", body);
export const archiveDepartment = (id, isActive) => apiClient.patch(`/departments/${id}`, { isActive });

export const listPositions = () => apiClient.get("/positions");
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

export const listDocumentTypesManage = () => apiClient.get("/workforce-config/document-types");
export const createDocumentType = (body) => apiClient.post("/workforce-config/document-types", body);
export const updateDocumentType = (id, body) => apiClient.patch(`/workforce-config/document-types/${id}`, body);

export const listProfileSections = () => apiClient.get("/workforce-config/sections");
export const createProfileSection = (body) => apiClient.post("/workforce-config/sections", body);
export const updateProfileSection = (id, body) => apiClient.patch(`/workforce-config/sections/${id}`, body);
export const listCustomFields = () => apiClient.get("/workforce-config/fields");
export const createCustomField = (body) => apiClient.post("/workforce-config/fields", body);
export const updateCustomField = (id, body) => apiClient.patch(`/workforce-config/fields/${id}`, body);

export const listRotationPolicies = () => apiClient.get("/rotation-policies");
export const createRotationPolicy = (body) => apiClient.post("/rotation-policies", body);
export const updateRotationPolicy = (id, body) => apiClient.patch(`/rotation-policies/${id}`, body);

export const downloadEmployeeMasterReport = () => apiClient.getBlob("/reports/workforce/employee-master.xlsx");
export const getReportCatalog = () => apiClient.get("/reports/workforce/catalog");
export const downloadWorkforceReport = (key, params = {}) => {
  const query = new URLSearchParams(params).toString();
  return apiClient.getBlob(`/reports/workforce/${key}.xlsx${query ? `?${query}` : ""}`);
};
export const downloadBulkFiles = (body) => apiClient.postBlob("/reports/workforce/bulk-files.zip", body);
export const downloadImportTemplate = () => apiClient.getBlob("/employees/import/template.xlsx");
export const previewEmployeeImport = (formData) => apiClient.post("/employees/import/preview", formData, { isForm: true });
export const confirmEmployeeImport = (formData) => apiClient.post("/employees/import/confirm", formData, { isForm: true });
export const listExpiringDocuments = (withinDays = 30) => apiClient.get(`/documents/expiring?withinDays=${withinDays}`);

// Governance
export const listUsers = () => apiClient.get("/users");
export const getUserPermissions = (id) => apiClient.get(`/users/${id}/permissions`);
export const setUserPermission = (id, code, body) => apiClient.put(`/users/${id}/permissions/${encodeURIComponent(code)}`, body);
export const removeUserPermission = (id, code) => apiClient.del(`/users/${id}/permissions/${encodeURIComponent(code)}`);
export const changeUserRole = (id, role) => apiClient.patch(`/users/${id}/role`, { role });
export const activateUser = (id) => apiClient.post(`/users/${id}/activate`, {});
export const deactivateUser = (id) => apiClient.post(`/users/${id}/deactivate`, {});
