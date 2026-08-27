import { apiClient } from "../../core/api/client.js";

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const value = query.toString();
  return value ? `?${value}` : "";
}

export const listOpenDeliveries = (filters) => apiClient.get(`/receiving/challans${buildQuery(filters)}`);
export const getDeliveryForReceiving = (dcId) => apiClient.get(`/receiving/challans/${dcId}`);
export const recordReceipt = (dcId, body) => apiClient.post(`/receiving/challans/${dcId}/receipts`, body);
export const listReceipts = (filters) => apiClient.get(`/receiving/receipts${buildQuery(filters)}`);
export const getReceipt = (id) => apiClient.get(`/receiving/receipts/${id}`);
export const acknowledgeHandover = (id) => apiClient.post(`/receiving/receipts/${id}/handover`, {});
export const confirmReceipt = (id) => apiClient.post(`/receiving/receipts/${id}/confirm`, {});
