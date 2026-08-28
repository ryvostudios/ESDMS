import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

export function listPricingQueue(filters) {
  return apiClient.get(`/procurement/pricing${buildQuery(filters)}`);
}

export function getPricing(demandId, version) {
  return apiClient.get(`/procurement/pricing/${demandId}${buildQuery({ version })}`);
}

export function savePricing(demandId, input) {
  return apiClient.put(`/procurement/pricing/${demandId}`, input);
}

export function submitPricing(demandId, input) {
  return apiClient.post(`/procurement/pricing/${demandId}/submit`, input);
}

export function startRepricing(demandId, input) {
  return apiClient.post(`/procurement/pricing/${demandId}/repricing`, input);
}
