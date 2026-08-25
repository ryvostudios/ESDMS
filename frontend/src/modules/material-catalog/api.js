import { apiClient } from "../../core/api/client.js";

export const listUnitsOfMeasure = () => apiClient.get("/material-catalog/units-of-measure");

export const listCatalog = (params = {}) => {
  const query = new URLSearchParams(
    Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== "")),
  ).toString();
  return apiClient.get(`/material-catalog${query ? `?${query}` : ""}`);
};

export const searchCompanyItems = (q, departmentId) => {
  const params = new URLSearchParams({ q, ...(departmentId && { departmentId }) });
  return apiClient.get(`/material-catalog/company-items/search?${params.toString()}`);
};

export const addCatalogEntry = (body) => apiClient.post("/material-catalog", body);
export const updateCatalogEntry = (id, body) => apiClient.patch(`/material-catalog/${id}`, body);
