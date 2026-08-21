import { TEST_PASSWORD } from "./setup.js";

export function buildCreatePayload(overrides = {}) {
  return {
    requestedBy: "Electrical Team Lead",
    destination: "Site B Warehouse",
    driverName: "Test Driver",
    driverPhone: "+923001234567",
    vehicleRegistration: `TST-${Math.floor(Math.random() * 100000)}`,
    purpose: "SAMPLE",
    items: [{ description: "Bearing assembly", quantity: 2, unit: "pcs" }],
    ...overrides,
  };
}

export async function authHeader(baseUrl, email, password = TEST_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ email, password }),
  });
  const body = await response.json();

  return `Bearer ${body.data.token}`;
}

export async function apiRequest(baseUrl, method, path, { token, body, isForm } = {}) {
  const headers = { Origin: "http://localhost:5173" };

  if (token) headers.Authorization = token;
  if (body && !isForm) headers["Content-Type"] = "application/json";

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // non-JSON response (e.g. binary file download)
  }

  return { status: response.status, body: payload, raw: response };
}

export function buildPhotoForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  // 1x1 transparent PNG
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  form.append("photo", new Blob([pngBytes], { type: "image/png" }), "evidence.png");

  return form;
}
