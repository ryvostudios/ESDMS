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

// Despite the name (kept to avoid an expensive rename across every test
// file's ~50 call sites), login no longer returns a bearer token at all
// (Fix #7 — see docs/DECISIONS.md) — this authenticates the same way the
// real browser does, by capturing the HttpOnly session cookie from the
// login response and handing it back as a plain "name=value" pair for
// apiRequest to send as a Cookie header.
export async function authHeader(baseUrl, email, password = TEST_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ email, password }),
  });

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) {
    throw new Error(`Login failed for ${email}: no session cookie in response.`);
  }

  return setCookie.split(";")[0];
}

// `token` here is a Cookie header value (see authHeader above), not a
// bearer token — kept as the option name since every test file already
// passes `{ token: tokens.xxx }`.
export async function apiRequest(baseUrl, method, path, { token, body, isForm } = {}) {
  const headers = { Origin: "http://localhost:5173" };

  if (token) headers.Cookie = token;
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

// 1x1 transparent PNG
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export function buildPhotoForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  form.append("photo", new Blob([PNG_BYTES], { type: "image/png" }), "evidence.png");

  return form;
}

// The multi-capture form: several photos under the "photos" field, which is
// what a Guard photographing more than one angle actually sends.
export function buildMultiPhotoForm(fields, count = 2) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  for (let index = 0; index < count; index += 1) {
    form.append("photos", new Blob([PNG_BYTES], { type: "image/png" }), `evidence-${index}.png`);
  }

  return form;
}

// A file whose declared Content-Type claims JPEG but whose bytes are not a
// JPEG at all — for proving the server checks the actual file signature
// rather than trusting the client's mimetype.
export function buildFakePhotoForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, String(value));
  }
  form.append("photo", new Blob([Buffer.from("not-really-an-image")], { type: "image/jpeg" }), "evidence.jpg");

  return form;
}
