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

function buildEvidenceForm({ odometer, photos, remarks }) {
  const form = new FormData();
  form.append("odometer", String(odometer));
  for (const photo of photos) form.append("photos", photo);
  if (remarks) form.append("remarks", remarks);
  return form;
}

export function recordExit(id, { odometer, photos }) {
  return apiClient.post(`/gate-passes/${id}/exit`, buildEvidenceForm({ odometer, photos }), { isForm: true });
}

export function recordReturn(id, { odometer, photos, remarks }) {
  return apiClient.post(`/gate-passes/${id}/return`, buildEvidenceForm({ odometer, photos, remarks }), {
    isForm: true,
  });
}

// Additional gate evidence outside the exit/return transitions — including
// inbound evidence of something that was never on the approved pass.
export function addGateEvidence(id, { kind, note, photos }) {
  const form = new FormData();
  form.append("kind", kind);
  if (note) form.append("note", note);
  for (const photo of photos) form.append("photos", photo);
  return apiClient.post(`/gate-passes/${id}/evidence`, form, { isForm: true });
}

export function listGateEvidence(id) {
  return apiClient.get(`/gate-passes/${id}/evidence`);
}
