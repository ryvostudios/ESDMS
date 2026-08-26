import { apiClient } from "../../core/api/client.js";

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const value = query.toString();
  return value ? `?${value}` : "";
}

export function listPricingQueue(filters) {
  return apiClient.get(`/procurement/pricing${buildQuery(filters)}`);
}

export function getPricing(demandId) {
  return apiClient.get(`/procurement/pricing/${demandId}`);
}

export function savePricing(demandId, input) {
  return apiClient.put(`/procurement/pricing/${demandId}`, input);
}

export function submitPricing(demandId, input) {
  return apiClient.post(`/procurement/pricing/${demandId}/submit`, input);
}

