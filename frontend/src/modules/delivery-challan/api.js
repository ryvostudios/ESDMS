import { apiClient } from "../../core/api/client.js";

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  }
  const value = query.toString();
  return value ? `?${value}` : "";
}

export const listDeliveryChallans = (filters) => apiClient.get(`/delivery-challans${buildQuery(filters)}`);
export const getDeliveryChallan = (id) => apiClient.get(`/delivery-challans/${id}`);
export const createDeliveryChallan = (body) => apiClient.post("/delivery-challans", body);
export const updateDeliveryChallan = (id, body) => apiClient.patch(`/delivery-challans/${id}`, body);
export const finalizeDeliveryChallan = (id) => apiClient.post(`/delivery-challans/${id}/finalize`, {});
export const cancelDeliveryChallan = (id, body) => apiClient.post(`/delivery-challans/${id}/cancel`, body);
export const getDeliveryChallanPdf = (id) => apiClient.getBlob(`/delivery-challans/${id}/pdf`);
