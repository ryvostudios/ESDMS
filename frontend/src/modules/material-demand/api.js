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

export function submitDemand(id) {
  return apiClient.post(`/demands/${id}/submit`, {});
}
