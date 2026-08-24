import "dotenv/config";
import { getDomain } from "tldts";

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

function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// The canonical form of a value that's semantically an origin. `.origin`
// is always exactly scheme + host[:port] regardless of what the input
// carried — so "https://app.example.com" and "https://app.example.com/"
// both canonicalize to the identical "https://app.example.com". Falls
// back to the original value on a parse failure so callers still have
// something sensible to report an error against (isCleanProductionOrigin,
// applied separately to the ORIGINAL raw input — see below — is what
// actually rejects a malformed value; this never silently drops a real
// path/query/credentials, because validation always runs against the raw
// string before this is used for storage).
function toOrigin(value) {
  try {
    return new URL(value).origin;
  } catch {
    return value;
  }
}

// A browser's CORS `Origin` header is always exactly scheme + host[:port]
// — never a path, query, fragment, or credentials. FRONTEND_ORIGIN is
// compared against that header (see app.js's CORS origin callback), and
// APP_PUBLIC_URL/API_PUBLIC_URL are each used as a bare base that other
// code appends its own path onto (QR deep links; same-site hostname
// extraction) — a value that already carries its own path/query/fragment
// would silently produce a malformed URL wherever it's concatenated, or
// simply misrepresent what's being compared. Checking the protocol alone
// doesn't catch any of that — a value like
// "https://app.example.com/some/path" is still https.
function isCleanProductionOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.pathname === "/" &&
    parsed.search === "" &&
    parsed.hash === ""
  );
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

// Canonicalized immediately — every downstream consumer (CORS, same-site
// validation, anything else) reads the normalized form, never the raw env
// text. validateProductionConfig() below re-parses process.env directly
// to validate the ORIGINAL input's shape (so a real embedded path/query/
// credentials is still rejected, not silently canonicalized away) —
// canonicalization and shape validation are deliberately independent
// passes over the same source value.
const frontendOrigins = parseOrigins(required("FRONTEND_ORIGIN")).map(toOrigin);
const jwtExpiresIn = process.env.JWT_EXPIRES_IN || "8h";
// "Remember me" login: a longer-lived JWT + matching cookie maxAge, issued
// only when the caller explicitly opts in (see auth.controller.js). Same
// token/cookie mechanism as the default session — no refresh token, no
// session table — so the existing session_version revocation (logout,
// password change, deactivation) invalidates a remembered session exactly
// as it does a normal one; the only difference is how long an unrevoked
// token stays valid.
//
// Deliberately a fixed constant, NOT deployment-configurable like
// JWT_EXPIRES_IN: a configurable duration STRING here would need identical
// parsing by both parseDurationMs (for the cookie) and jsonwebtoken (for
// the JWT's exp claim) — those disagree on a bare unitless value like
// "604800" (parseDurationMs treats it as seconds; jsonwebtoken's own zeit/ms
// parser treats a bare *string* number as milliseconds), which could
// silently mint a JWT and cookie with very different lifetimes. A single
// canonical NUMBER of seconds sidesteps that ambiguity entirely —
// jsonwebtoken's `expiresIn` treats a numeric value as an unambiguous
// seconds count, and the cookie's maxAge below is just that same number of
// seconds converted to milliseconds. Nothing else may derive its own
// remember-me duration from anywhere but this constant.
const REMEMBER_ME_TTL_SECONDS = 7 * 24 * 60 * 60; // 604800
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
// Canonicalized (see toOrigin) so a trailing slash can never produce a
// doubled separator when a path is appended onto it, e.g. in
// gate-pass.pdf.js's verification URL.
const appPublicUrl = toOrigin(process.env.APP_PUBLIC_URL || frontendOrigins[0]);
// The backend's OWN public URL — used only to validate, at startup, that
// the frontend and API are deployed same-site (see
// validateSameSiteCookieTopology below). Distinct from appPublicUrl.
// Optional in development; required in production. Canonicalized the same
// way when present.
const apiPublicUrl = process.env.API_PUBLIC_URL ? toOrigin(process.env.API_PUBLIC_URL) : process.env.API_PUBLIC_URL;

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
  // The one canonical remember-me duration — see REMEMBER_ME_TTL_SECONDS
  // above. jwt.sign's `expiresIn` gets the number of seconds directly (never
  // a string); the cookie's maxAge gets that same number * 1000. Both
  // consumers read these two fields and nothing else, so they cannot drift.
  rememberMeTtlSeconds: REMEMBER_ME_TTL_SECONDS,
  rememberMeTtlMs: REMEMBER_ME_TTL_SECONDS * 1000,
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

// eTLD+1 (registrable domain) via the Public Suffix List, not a homemade
// "last two labels" heuristic — that naive approach is wrong for
// multi-label suffixes (app.company.com.pk / api.company.com.pk ARE
// same-site; app.customer-a.com.pk / api.customer-b.com.pk are NOT, but
// "last two labels" would get the second case backwards). allowPrivateDomains
// also makes tldts treat PSL "private section" entries — Render, Vercel,
// Netlify, Heroku, GitHub Pages, Fly.io, Railway, etc. — as their own
// suffix, so two different customers' subdomains under one of those are
// correctly NOT same-site either, without this codebase maintaining its
// own partial list of platform domains.
function registrableSite(hostname) {
  return getDomain(hostname, { allowPrivateDomains: true });
}

function validateSameSiteCookieTopology(problems) {
  if (!apiPublicUrl || !apiPublicUrl.trim()) {
    problems.push(
      "API_PUBLIC_URL must be set in production — the backend's own public HTTPS URL. It's used to verify the frontend and API are deployed same-site, which the HttpOnly SameSite=Lax session cookie requires to work at all (see docs/SECURITY.md).",
    );
    return;
  }

  // Validated against the RAW env text, not the already-canonicalized
  // apiPublicUrl — canonicalization (toOrigin) silently discards
  // path/query/fragment/credentials, which would make this check trivially
  // pass for exactly the malformed inputs it exists to catch.
  if (!isCleanProductionOrigin(process.env.API_PUBLIC_URL)) {
    problems.push(
      `API_PUBLIC_URL "${process.env.API_PUBLIC_URL}" must be a bare https:// origin in production — no path, query, fragment, or embedded credentials (e.g. "https://api.example.com", not "https://api.example.com/v1" or a URL with "user:pass@").`,
    );
    return;
  }

  const apiHost = new URL(apiPublicUrl).hostname;
  const apiSite = registrableSite(apiHost);

  if (!apiSite) {
    problems.push(
      `API_PUBLIC_URL "${apiPublicUrl}" does not resolve to a registrable domain (e.g. it's a bare IP or a single-label host) — same-site cookie validation can't be performed against it.`,
    );
    return;
  }

  for (const origin of frontendOrigins) {
    let frontendHost;
    try {
      frontendHost = new URL(origin).hostname;
    } catch {
      continue; // already reported as an invalid FRONTEND_ORIGIN below
    }

    const frontendSite = registrableSite(frontendHost);

    if (!frontendSite) {
      problems.push(
        `FRONTEND_ORIGIN "${frontendHost}" does not resolve to a registrable domain — same-site cookie validation can't be performed against it.`,
      );
    } else if (frontendSite !== apiSite) {
      problems.push(
        `FRONTEND_ORIGIN "${frontendHost}" and API_PUBLIC_URL "${apiHost}" are not same-site (registrable domains "${frontendSite}" vs "${apiSite}"). Separate default platform domains (e.g. a "*-frontend.onrender.com" paired with a "*-api.onrender.com") are NOT a supported topology for authenticated production use — the session cookie will never be sent. Deploy both under the same registrable domain instead (e.g. app.<domain> and api.<domain>), or put a same-origin reverse proxy in front of both.`,
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

  // Validated against the RAW env text (re-parsed from process.env
  // directly), not the already-canonicalized frontendOrigins/appPublicUrl
  // — canonicalization (toOrigin) silently discards path/query/fragment/
  // credentials, which would make this check trivially pass for exactly
  // the malformed inputs it exists to catch.
  const frontendOriginsRaw = parseOrigins(process.env.FRONTEND_ORIGIN || "");
  for (const origin of frontendOriginsRaw) {
    if (!isCleanProductionOrigin(origin)) {
      problems.push(
        `FRONTEND_ORIGIN "${origin}" must be a bare https:// origin in production — no path, query, fragment, or embedded credentials. A browser's CORS Origin header never carries any of those, so a value that does can never actually match one (e.g. "https://app.example.com", not "https://app.example.com/path" or "https://app.example.com?x=1").`,
      );
    }
  }

  const appPublicUrlRaw = process.env.APP_PUBLIC_URL || frontendOriginsRaw[0];
  if (!isCleanProductionOrigin(appPublicUrlRaw)) {
    problems.push(
      `APP_PUBLIC_URL "${appPublicUrlRaw}" must be a bare https:// origin in production — no path, query, fragment, or embedded credentials. This is embedded in every Gate Pass QR code as a base that "/guard/verify" is appended onto; a value with its own path would produce a malformed link.`,
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
