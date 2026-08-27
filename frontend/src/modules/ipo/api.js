import { apiClient } from "../../core/api/client.js";

function buildQuery(params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (Array.isArray(value)) {
      value.forEach((entry) => query.append(key, entry));
    } else if (value !== undefined && value !== null && value !== "") {
      query.set(key, value);
    }
  }
  const value = query.toString();
  return value ? `?${value}` : "";
}

export const listIpos = (filters) => apiClient.get(`/ipos${buildQuery(filters)}`);
export const getIpo = (id) => apiClient.get(`/ipos/${id}`);
export const acknowledgeIpo = (id) => apiClient.post(`/ipos/${id}/acknowledge`, {});
export const recordPurchase = (id, body) => apiClient.post(`/ipos/${id}/purchases`, body);
export const closePurchasing = (id) => apiClient.post(`/ipos/${id}/close-purchasing`, {});
export const cancelIpo = (id, body) => apiClient.post(`/ipos/${id}/cancel`, body);
export const getIpoPdf = (id) => apiClient.getBlob(`/ipos/${id}/pdf`);
export const listOutstanding = (params) => apiClient.get(`/ipos/outstanding${buildQuery(params)}`);
