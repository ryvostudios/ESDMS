import { apiClient } from "../../core/api/client.js";
import { buildQuery } from "../../core/api/query.js";

export const listDrivers = (filters) => apiClient.get(`/drivers${buildQuery(filters)}`);
export const getDriver = (id) => apiClient.get(`/drivers/${id}`);
export const createDriver = (body) => apiClient.post("/drivers", body);
export const updateDriver = (id, body) => apiClient.patch(`/drivers/${id}`, body);

export const listVehicles = (filters) => apiClient.get(`/vehicles${buildQuery(filters)}`);
export const getVehicle = (id) => apiClient.get(`/vehicles/${id}`);
export const createVehicle = (body) => apiClient.post("/vehicles", body);
export const updateVehicle = (id, body) => apiClient.patch(`/vehicles/${id}`, body);
