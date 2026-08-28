import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

export function listGatePasses(filters) {
  return apiClient.get(`/gate-passes${buildQuery(filters)}`);
}

export function getGatePass(id) {
  return apiClient.get(`/gate-passes/${id}`);
}

export function createGatePass(input) {
  return apiClient.post("/gate-passes", input);
}

export function updateGatePassDraft(id, input) {
  return apiClient.patch(`/gate-passes/${id}`, input);
}

export function submitGatePass(id) {
  return apiClient.post(`/gate-passes/${id}/submit`, {});
}

export function approveGatePass(id) {
  return apiClient.post(`/gate-passes/${id}/approve`, {});
}

export function rejectGatePass(id, reason) {
  return apiClient.post(`/gate-passes/${id}/reject`, { reason });
}

export function cancelGatePass(id, reason) {
  return apiClient.post(`/gate-passes/${id}/cancel`, { reason });
}

export function downloadGatePassPdf(id) {
  return apiClient.getBlob(`/gate-passes/${id}/pdf`);
}

export function downloadGatePassFile(id, fileId) {
  return apiClient.getBlob(`/gate-passes/${id}/files/${fileId}`);
}

export function listDepartments() {
  return apiClient.get("/departments");
}
