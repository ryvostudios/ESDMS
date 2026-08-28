import { apiClient } from "../../core/api/client.js";

function buildQuery(params) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, value);
    }
  }

  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

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
  const query = new URLSearchParams();
  catalogEntryIds.forEach((id) => query.append("catalogEntryIds", id));
  if (departmentId) query.set("departmentId", departmentId);
  return apiClient.get(`/ipos/outstanding?${query.toString()}`);
}
