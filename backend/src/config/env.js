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

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

const nodeEnv = process.env.NODE_ENV || "development";
const jwtSecret = required("JWT_SECRET");

if (jwtSecret.length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters long.");
}

const frontendOrigins = parseOrigins(required("FRONTEND_ORIGIN"));
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "8h";
const isProduction = nodeEnv === "production";

// Render (and most PaaS reverse proxies) route public traffic to the
// container over its internal network — a server bound only to
// 127.0.0.1/localhost is unreachable from outside the container no matter
// what the proxy does. 0.0.0.0 (all interfaces) is exactly as safe here as
// 127.0.0.1: the proxy is still the only thing internet traffic can reach,
// CORS/auth/rate-limiting are unchanged, and nothing about listening
// address exposes Postgres or any other internal service.
const host = process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1");

// Required to be explicit in production (not defaulted) rather than
// silently assuming "no proxy" — Render always proxies, and getting this
// wrong either breaks IP-based rate limiting (0 behind a real proxy) or
// lets a client spoof X-Forwarded-For and defeat it entirely (a value
// that's too high). Local dev has no proxy, so 0 is a safe, harmless
// default there.
const trustProxyHopsRaw = process.env.TRUST_PROXY_HOPS;
if (isProduction && (trustProxyHopsRaw === undefined || trustProxyHopsRaw.trim() === "")) {
  throw new Error(
    "TRUST_PROXY_HOPS must be set explicitly in production (e.g. 1 for Render's default single proxy hop).",
  );
}
const trustProxyHops = Number(trustProxyHopsRaw) || 0;

const appPublicUrl = process.env.APP_PUBLIC_URL || frontendOrigins[0];
const storageProvider = process.env.STORAGE_PROVIDER || "local";

export const config = {
  nodeEnv,
  isProduction,
  host,
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
  appPublicUrl,
  // IANA zone the business operates in — used for anything date-numbering
  // sensitive (e.g. the gate pass number's year) so it stays deterministic
  // regardless of the host machine's local timezone. Stored timestamps
  // remain UTC/timestamptz; this only affects display/derivation.
  appTimezone: process.env.APP_TIMEZONE || "Asia/Karachi",
  storageDir: process.env.STORAGE_DIR || "./storage",
  // "local" (disk) or "supabase" (private bucket) — see
  // shared/storage/storage-service.js. Local is refused at startup in
  // production unless explicitly opted into (see validateProductionConfig).
  storageProvider,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET,
  trustProxyHops,
  sessionCookieName: "esdms_session",
  // Unset (host-only cookie) unless a deployment explicitly needs the
  // session shared across subdomains.
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
};

// Fail startup, not a request three weeks later, when production is
// configured in a way that's syntactically valid but operationally unsafe
// or simply broken. Collects every problem instead of stopping at the
// first, so a misconfigured deploy doesn't take five redeploys to fully
// diagnose.
function validateProductionConfig() {
  const problems = [];

  for (const origin of frontendOrigins) {
    if (!isHttpsUrl(origin)) {
      problems.push(`FRONTEND_ORIGIN "${origin}" must be an https:// URL in production.`);
    }
  }

  if (!isHttpsUrl(appPublicUrl)) {
    problems.push(
      `APP_PUBLIC_URL "${appPublicUrl}" must be an https:// URL in production — this is embedded in every Gate Pass QR code.`,
    );
  }

  if (storageProvider === "local") {
    problems.push(
      'STORAGE_PROVIDER=local (or unset) in production — Render\'s local filesystem is ephemeral and unsuitable for Gate Pass evidence/PDF persistence. Set STORAGE_PROVIDER=supabase, or STORAGE_PROVIDER=local-single-instance-accepted-risk if this deployment deliberately runs as a single persistent-disk instance.',
    );
  }

  if (storageProvider === "supabase") {
    for (const [name, value] of Object.entries({
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_STORAGE_BUCKET: process.env.SUPABASE_STORAGE_BUCKET,
    })) {
      if (!value || !value.trim()) {
        problems.push(`${name} is required when STORAGE_PROVIDER=supabase.`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid production configuration:\n- ${problems.join("\n- ")}`);
  }
}

if (isProduction) {
  validateProductionConfig();
}

export default config;
