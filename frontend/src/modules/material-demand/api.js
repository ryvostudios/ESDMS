import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

export function listDemands(filters) {
  return apiClient.get(`/demands${buildQuery(filters)}`);
}

export function getDemand(id) {
  return apiClient.get(`/demands/${id}`);
}

export function createDemand(input) {
  return apiClient.post("/demands", input);
}

export function updateDemandDraft(id, input) {
  return apiClient.patch(`/demands/${id}`, input);
}

export function deleteDraftDemand(id) {
  return apiClient.del(`/demands/${id}`);
}

export function submitDemand(id) {
  return apiClient.post(`/demands/${id}/submit`, {});
}

export function recordManagementReview(id, body) {
  return apiClient.post(`/demands/${id}/reviews`, body);
}

export function recordFormalApproval(id, body) {
  return apiClient.post(`/demands/${id}/approvals`, body);
}

export function recordFinalManagementReview(id, body) {
  return apiClient.post(`/demands/${id}/final-reviews`, body);
}

export function recordFinalFormalApproval(id, body) {
  return apiClient.post(`/demands/${id}/final-approvals`, body);
}

export function setLineDispositions(id, body) {
  return apiClient.put(`/demands/${id}/line-dispositions`, body);
}

export function getDemandPdf(id) {
  return apiClient.getBlob(`/demands/${id}/pdf`);
}

export function listOutstandingForCatalogEntries(catalogEntryIds, departmentId) {
  return apiClient.get(`/ipos/outstanding${buildQuery({ catalogEntryIds, departmentId })}`);
}
