import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

export const listDeliveryChallans = (filters) => apiClient.get(`/delivery-challans${buildQuery(filters)}`);
export const getDeliveryChallan = (id) => apiClient.get(`/delivery-challans/${id}`);
export const createDeliveryChallan = (body) => apiClient.post("/delivery-challans", body);
export const updateDeliveryChallan = (id, body) => apiClient.patch(`/delivery-challans/${id}`, body);
export const finalizeDeliveryChallan = (id) => apiClient.post(`/delivery-challans/${id}/finalize`, {});
export const cancelDeliveryChallan = (id, body) => apiClient.post(`/delivery-challans/${id}/cancel`, body);
export const getDeliveryChallanPdf = (id) => apiClient.getBlob(`/delivery-challans/${id}/pdf`);
