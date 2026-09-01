import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

export const listIpos = (filters) => apiClient.get(`/ipos${buildQuery(filters)}`);
export const getIpo = (id) => apiClient.get(`/ipos/${id}`);
export const acknowledgeIpo = (id) => apiClient.post(`/ipos/${id}/acknowledge`, {});
export const recordPurchase = (id, body) => apiClient.post(`/ipos/${id}/purchases`, body);
export const closePurchasing = (id) => apiClient.post(`/ipos/${id}/close-purchasing`, {});
export const cancelIpo = (id, body) => apiClient.post(`/ipos/${id}/cancel`, body);
export const getIpoPdf = (id) => apiClient.getBlob(`/ipos/${id}/pdf`);
