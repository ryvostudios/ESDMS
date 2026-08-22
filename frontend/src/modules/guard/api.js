import { apiClient } from "../../core/api/client.js";

export function getGuardDashboard() {
  return apiClient.get("/gate-passes/guard/dashboard");
}

export function searchGuard(query) {
  return apiClient.get(`/gate-passes/guard/search?query=${encodeURIComponent(query)}`);
}

export function verifyByToken(token) {
  return apiClient.post("/gate-passes/guard/verify", { token });
}

export function getGuardGatePass(id) {
  return apiClient.get(`/gate-passes/guard/${id}`);
}

function buildEvidenceForm({ odometer, photo, remarks }) {
  const form = new FormData();
  form.append("odometer", String(odometer));
  form.append("photo", photo);
  if (remarks) form.append("remarks", remarks);
  return form;
}

export function recordExit(id, { odometer, photo }) {
  return apiClient.post(`/gate-passes/${id}/exit`, buildEvidenceForm({ odometer, photo }), { isForm: true });
}

export function recordReturn(id, { odometer, photo, remarks }) {
  return apiClient.post(`/gate-passes/${id}/return`, buildEvidenceForm({ odometer, photo, remarks }), {
    isForm: true,
  });
}
