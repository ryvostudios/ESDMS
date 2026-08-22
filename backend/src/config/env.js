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

function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// Strict non-negative integer parser for config values. `Number(raw)` alone
// isn't enough: `Number("Infinity")` and `Number("1.5")` are both "valid"
// finite-looking numbers unless checked, and a malformed value silently
// falling back to a default (e.g. `Number("abc") || 0`) is exactly the
// defect this exists to prevent — a bad config must fail loudly, not
// coerce into something that happens to run.
function parseStrictInt(raw, { min, max }) {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) return null;
  return value;
}

function isValidTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
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

const portRaw = process.env.PORT;
let port = 3000;
if (portRaw !== undefined && portRaw.trim() !== "") {
  const parsedPort = parseStrictInt(portRaw.trim(), { min: 1, max: 65535 });
  if (parsedPort === null) {
    throw new Error(`PORT must be an integer between 1 and 65535 (got "${portRaw}").`);
  }
  port = parsedPort;
}

// Required to be explicit in production (not defaulted) rather than
// silently assuming "no proxy" — Render always proxies, and getting this
// wrong either breaks IP-based rate limiting (0 behind a real proxy) or
// lets a client spoof X-Forwarded-For and defeat it entirely (a value
// that's too high). Local dev has no proxy, so 0 is a safe, harmless
// default there. Bounded at 10: a legitimate deployment sits behind a
// small, known number of reverse proxies — an unbounded value defeats the
// point of validating it at all.
const trustProxyHopsRaw = process.env.TRUST_PROXY_HOPS;
if (isProduction && (trustProxyHopsRaw === undefined || trustProxyHopsRaw.trim() === "")) {
  throw new Error(
    "TRUST_PROXY_HOPS must be set explicitly in production (e.g. 1 for Render's default single proxy hop).",
  );
}
let trustProxyHops = 0;
if (trustProxyHopsRaw !== undefined && trustProxyHopsRaw.trim() !== "") {
  const parsedHops = parseStrictInt(trustProxyHopsRaw.trim(), { min: 0, max: 10 });
  if (parsedHops === null) {
    throw new Error(`TRUST_PROXY_HOPS must be an integer between 0 and 10 (got "${trustProxyHopsRaw}").`);
  }
  trustProxyHops = parsedHops;
}

// The FRONTEND's public URL, embedded as the deep-link base in every Gate
// Pass QR code — not the backend's own URL (see apiPublicUrl below).
const appPublicUrl = process.env.APP_PUBLIC_URL || frontendOrigins[0];
// The backend's OWN public URL — used only to validate, at startup, that
// the frontend and API are deployed same-site (see
// validateSameSiteCookieTopology below). Distinct from appPublicUrl.
// Optional in development; required in production.
const apiPublicUrl = process.env.API_PUBLIC_URL;

const appTimezone = process.env.APP_TIMEZONE || "Asia/Karachi";
if (!isValidTimezone(appTimezone)) {
  throw new Error(`APP_TIMEZONE "${appTimezone}" is not a recognized IANA timezone.`);
}

const storageProvider = process.env.STORAGE_PROVIDER || "local";

const storageTimeoutRaw = process.env.SUPABASE_STORAGE_TIMEOUT_MS;
let supabaseStorageTimeoutMs = 10_000;
if (storageTimeoutRaw !== undefined && storageTimeoutRaw.trim() !== "") {
  const parsedTimeout = parseStrictInt(storageTimeoutRaw.trim(), { min: 1000, max: 120_000 });
  if (parsedTimeout === null) {
    throw new Error(
      `SUPABASE_STORAGE_TIMEOUT_MS must be an integer between 1000 and 120000 (got "${storageTimeoutRaw}").`,
    );
  }
  supabaseStorageTimeoutMs = parsedTimeout;
}

export const config = {
  nodeEnv,
  isProduction,
  host,
  port,
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
  // The backend's own public URL — see the declaration above.
  apiPublicUrl,
  // IANA zone the business operates in — used for anything date-numbering
  // sensitive (e.g. the gate pass number's year) so it stays deterministic
  // regardless of the host machine's local timezone. Stored timestamps
  // remain UTC/timestamptz; this only affects display/derivation.
  appTimezone,
  storageDir: process.env.STORAGE_DIR || "./storage",
  // "local" (disk) or "supabase" (private bucket) — see
  // shared/storage/storage-service.js. Local is refused at startup in
  // production unless explicitly opted into (see validateProductionConfig).
  storageProvider,
  supabaseStorageTimeoutMs,
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  supabaseStorageBucket: process.env.SUPABASE_STORAGE_BUCKET,
  trustProxyHops,
  sessionCookieName: "esdms_session",
  // Unset (host-only cookie) unless a deployment explicitly needs the
  // session shared across subdomains.
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

// Render (and most PaaS platforms that hand each customer a subdomain of a
// shared parent, e.g. *.onrender.com) behave as a public suffix for cookie
// purposes: two different customer subdomains under them are NOT the same
// "site" even though they share a DNS parent. A first-party session cookie
// (SameSite=Lax, no CSRF token by design — see docs/SECURITY.md) silently
// stops being sent the moment the frontend and API sit on two such
// unrelated subdomains — the browser just never attaches it, and "login
// doesn't work" is the only symptom. This must fail at deploy time.
const KNOWN_MULTI_TENANT_HOST_SUFFIXES = [
  "onrender.com",
  "vercel.app",
  "netlify.app",
  "herokuapp.com",
  "pages.dev",
  "railway.app",
  "fly.dev",
];

function registrableSite(hostname) {
  const lower = hostname.toLowerCase();
  const knownSuffix = KNOWN_MULTI_TENANT_HOST_SUFFIXES.find(
    (suffix) => lower === suffix || lower.endsWith(`.${suffix}`),
  );
  // Under a known multi-tenant host, the whole subdomain IS the site — one
  // customer's *.onrender.com name is not "the same site" as another's.
  if (knownSuffix) return lower;
  // Naive eTLD+1 (last two labels) for ordinary custom domains — correct
  // for the common case (app.example.com / api.example.com -> example.com).
  // Doesn't handle multi-part public suffixes like co.uk; a deployment on
  // one of those should double-check its own topology manually.
  const labels = lower.split(".");
  return labels.slice(-2).join(".");
}

function validateSameSiteCookieTopology(problems) {
  if (!apiPublicUrl || !apiPublicUrl.trim()) {
    problems.push(
      "API_PUBLIC_URL must be set in production — the backend's own public HTTPS URL. It's used to verify the frontend and API are deployed same-site, which the HttpOnly SameSite=Lax session cookie requires to work at all (see docs/SECURITY.md).",
    );
    return;
  }

  if (!isHttpsUrl(apiPublicUrl)) {
    problems.push(`API_PUBLIC_URL "${apiPublicUrl}" must be an https:// URL in production.`);
    return;
  }

  const apiHost = new URL(apiPublicUrl).hostname;
  const apiSite = registrableSite(apiHost);

  for (const origin of frontendOrigins) {
    let frontendHost;
    try {
      frontendHost = new URL(origin).hostname;
    } catch {
      continue; // already reported as an invalid FRONTEND_ORIGIN below
    }

    if (registrableSite(frontendHost) !== apiSite) {
      problems.push(
        `FRONTEND_ORIGIN "${frontendHost}" and API_PUBLIC_URL "${apiHost}" are not same-site. Separate default platform domains (e.g. a "*-frontend.onrender.com" paired with a "*-api.onrender.com") are NOT a supported topology for authenticated production use — the session cookie will never be sent. Deploy both under the same registrable domain instead (e.g. app.<domain> and api.<domain>), or put a same-origin reverse proxy in front of both.`,
      );
    }
  }
}

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

  validateSameSiteCookieTopology(problems);

  if (LOOPBACK_HOSTS.has(host)) {
    problems.push(
      `HOST "${host}" is a loopback address and unreachable from outside the container in production. Render (and most PaaS platforms) expect 0.0.0.0 — leave HOST unset (production already defaults to 0.0.0.0) or set it explicitly.`,
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

    if (process.env.SUPABASE_URL) {
      if (!isValidUrl(process.env.SUPABASE_URL)) {
        problems.push(`SUPABASE_URL "${process.env.SUPABASE_URL}" is not a valid URL.`);
      } else {
        const parsedSupabaseUrl = new URL(process.env.SUPABASE_URL);
        if (parsedSupabaseUrl.protocol !== "https:") {
          problems.push(`SUPABASE_URL "${process.env.SUPABASE_URL}" must be an https:// URL in production.`);
        }
        if (parsedSupabaseUrl.username || parsedSupabaseUrl.password) {
          problems.push("SUPABASE_URL must not embed credentials in the URL itself (use SUPABASE_SERVICE_ROLE_KEY).");
        }
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
