import "dotenv/config";

function required(name) {
  const value = process.env[name];

  if (!value || !value.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function parseOrigins(value) {
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

// Supports the same shorthand jsonwebtoken accepts ("8h", "15m", "30d", or
// a plain number of seconds) so JWT_EXPIRES_IN stays the single source of
// truth for both the token's exp claim and the session cookie's Max-Age.
function parseDurationMs(value) {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(value.trim());

  if (!match) {
    throw new Error(`Invalid duration format: ${value}`);
  }

  const amount = Number(match[1]);
  const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]?.toLowerCase() || "s"];

  return amount * unitMs;
}

const nodeEnv = process.env.NODE_ENV || "development";
const jwtSecret = required("JWT_SECRET");

if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long.");
}

const frontendOrigins = parseOrigins(required("FRONTEND_ORIGIN"));
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "8h";
const isProduction = nodeEnv === "production";

export const config = {
  nodeEnv,
  isProduction,
  port: Number(process.env.PORT) || 3000,
  databaseUrl: required("DATABASE_URL"),
  jwtSecret,
  jwtExpiresIn,
  jwtExpiresInMs: parseDurationMs(jwtExpiresIn),
  // Fixed, non-secret identifiers — not deployment-specific, so not env
  // vars. Rejecting tokens without a matching iss/aud is cheap defense in
  // depth against a token minted for a different purpose ever being
  // accepted here.
  jwtIssuer: "esdms-api",
  jwtAudience: "esdms-frontend",
  frontendOrigins,
  // Base URL embedded in Gate Pass QR codes as a deep link. Defaults to the
  // first allowed frontend origin when not set explicitly.
  appPublicUrl: process.env.APP_PUBLIC_URL || frontendOrigins[0],
  storageDir: process.env.STORAGE_DIR || "./storage",
  // Number of trusted reverse-proxy hops in front of this server (e.g. 1 on
  // Render). Required to be explicit rather than defaulting to "trust all
  // proxies", which would let a client spoof X-Forwarded-For and defeat
  // IP-based rate limiting entirely. 0 (default) means "no proxy — trust
  // the socket's own remote address only", correct for local dev.
  trustProxyHops: Number(process.env.TRUST_PROXY_HOPS) || 0,
  sessionCookieName: "esdms_session",
  // Unset (host-only cookie) unless a deployment explicitly needs the
  // session shared across subdomains.
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
};

export default config;
