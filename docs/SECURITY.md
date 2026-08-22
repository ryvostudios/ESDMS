# E-Set Digital Management System
## Security Requirements

## 1. Security Principle

Security is a system requirement, not a frontend feature.

The browser is an untrusted client.

Anything sent from React can potentially be:

- inspected,
- altered,
- replayed,
- automated,
- manually called,
- manipulated through browser developer tools.

The backend must independently verify sensitive operations.

---

## 2. Security Priority

When implementation choices conflict, prioritize:

1. Security
2. Data integrity
3. Authorization and isolation
4. Maintainability
5. Module independence
6. Auditability
7. Reliability
8. Testing
9. Simple UX
10. Development speed

Never weaken security simply to finish development faster.

---

## 3. Secrets

Never expose backend secrets to frontend JavaScript.

Examples of secrets that must remain server-side:

- database credentials,
- database URLs containing credentials,
- JWT/session signing secrets,
- private API keys,
- object-storage credentials,
- SMTP credentials,
- private keys,
- backend administrative credentials.

Actual `.env` files must not be committed.

Only safe `.env.example` templates may be committed.

Never log secrets.

---

## 4. Password Security

Passwords must never be stored in plaintext.

Use a reputable password-hashing implementation such as bcrypt/bcryptjs with an appropriate work factor.

Password-related rules:

- never log passwords,
- never return password hashes through APIs,
- never expose password hashes to the frontend,
- validate authentication inputs,
- rate-limit sensitive authentication endpoints.

---

## 5. Authentication

Authentication answers:

> Who is the user?

Authentication implementation must be server-controlled.

Before implementing authentication, explicitly decide the session/token architecture.

Preferred properties include:

- short-lived access authentication,
- secure HTTP-only cookies where appropriate,
- Secure cookies in production,
- SameSite protection,
- defined refresh/session behavior,
- logout/session revocation,
- token expiration,
- server-side verification.

Do not casually store long-lived bearer tokens in browser localStorage.

### 5.1 Current Implementation

- `POST /auth/login` sets an `HttpOnly`, `SameSite=Lax`, `Secure`-in-production
  session cookie and returns the user/profile in the JSON body — **never** the
  raw JWT. The frontend never sees or stores the token; `Authorization: Bearer`
  remains available server-side only for non-browser clients (scripts, the
  backend test suite).
- Session revocation is a `session_version` integer column on `users`,
  embedded in the JWT as an `sv` claim at login and compared against the live
  DB value on every authenticated request (`src/middleware/authenticate.js`).
  Logout bumps `session_version`, which immediately invalidates every
  outstanding token for that user (coarse, user-wide revocation — not
  per-device — chosen for simplicity; see `docs/DECISIONS.md`).
- Logout distinguishes "nothing to revoke" (missing/invalid/expired token —
  succeeds, since the outcome the caller wants is already true) from a real
  database failure while bumping `session_version` for a token that WAS
  valid: the latter returns `503` and leaves the cookie in place, rather
  than reporting success for a session that was never actually revoked
  server-side (`src/modules/auth/auth.controller.js`). The frontend only
  clears local session state on a confirmed `200` (`AuthContext.jsx`) and
  shows an explicit "Could not securely sign out" message otherwise.
- Every authenticated request re-checks the user's, their role's, **and**
  their site's active flags from the database (`isProfileActive`,
  `src/shared/users/user-profile.repository.js`) — a JWT issued while
  everything was active does not remain valid after an admin deactivates the
  site or account mid-session.

### 5.2 Render Cookie Topology (Deployment-Critical)

The session cookie is `HttpOnly` + `SameSite=Lax` with **no CSRF token** —
deliberately (see `docs/DECISIONS.md`): `SameSite=Lax` already excludes the
cookie from the cross-site fetch/XHR requests a CSRF token would otherwise
guard against. This is correct and sufficient **only if the frontend and
API are deployed same-site** — sharing one registrable domain (e.g.
`app.example.com` and `api.example.com`, both under `example.com`).

**Two separate default Render service domains (e.g.
`esdms-frontend.onrender.com` and `esdms-api.onrender.com`) are NOT
same-site.** Render hands each service its own subdomain of the shared
`onrender.com` parent, which behaves as a public suffix for cookie
purposes — the browser treats each one as an unrelated site. A default
two-service Render deployment will **start successfully and appear to
work** (the API answers `/health`, the frontend loads) but **login will
silently fail to persist**: the browser never attaches the session cookie
to cross-site requests, so every request after login looks unauthenticated
again. There is no error to see — just an app that seems to forget you
immediately after logging in.

**Do not fix this by setting `SameSite=None`** without also adding real
CSRF protection — that would remove the one thing currently standing in
for a CSRF token. It is deliberately not supported as a configuration
option in this codebase.

**Required production topology**: same-site custom domains —

```
app.<company-domain>   → Render Static Site (frontend)
api.<company-domain>   → Render Web Service (backend)
```

Both share one registrable domain, so the existing `HttpOnly` /
`SameSite=Lax` cookie design works unchanged. No real company domain is
hardcoded anywhere in this codebase — it's entirely environment-driven via
`FRONTEND_ORIGIN` (frontend) and `API_PUBLIC_URL` (backend, new — see
`.env.example`).

**Enforcement**: `validateProductionConfig()` (`src/config/env.js`)
requires `API_PUBLIC_URL` in production and rejects startup if
`FRONTEND_ORIGIN`'s registrable domain doesn't match `API_PUBLIC_URL`'s —
including the specific known-unsafe case of two different subdomains under
`onrender.com` (and a handful of other common multi-tenant PaaS host
suffixes: `vercel.app`, `netlify.app`, `herokuapp.com`, `pages.dev`,
`railway.app`, `fly.dev`). This is a heuristic, not a full public-suffix-
list implementation — it catches the specific failure mode described
above, not every conceivable domain edge case.

An alternative for a topology that genuinely can't use one registrable
domain: put a same-origin reverse proxy in front of both frontend and API
so the browser only ever talks to one origin. Not implemented in this
codebase; the custom-domain approach above is simpler and sufficient for
the current deployment target.

---

## 6. Authorization

Authorization answers:

> What is this authenticated user allowed to do?

Authorization must be enforced server-side.

Plan for:

- roles,
- departments,
- permissions,
- module access,
- action permissions,
- record/resource scope,
- ownership where applicable.

Do not scatter hard-coded authorization checks throughout controllers.

Use centralized authorization mechanisms where practical.

Frontend permission checks exist for user experience only.

---

## 7. Record-Level Authorization

Every protected record lookup must verify that the current user is authorized to access that record.

Changing an identifier must never allow access to another user's or department's data.

Example threat:

```text
/api/v1/gate-passes/123
must not become unauthorized access simply by changing it to:
/api/v1/gate-passes/124
```

Enforced in this codebase by `isWithinGatePassScope` (site check, then role-scoped department check) called from every service function that loads a Gate Pass by id — see `src/modules/gate-pass/gate-pass.authorization.js`.

---

## 8. Database Transport Security and Privilege Boundary

### 8.1 Transport (TLS)

The application must never connect to its production database over an unencrypted or unverified connection.

- In production (`NODE_ENV=production`), the runtime Postgres pool (`src/config/database.js`) requires TLS with certificate verification (`ssl: { rejectUnauthorized: true }`), not merely an encrypted-but-unverified connection.
- Local development connects to a local Postgres instance with no TLS, since `NODE_ENV` is not `production` there.
- The production Postgres instance itself must never be reachable on a public, unauthenticated port. When using Supabase, use its pooled/managed connection endpoint, not a raw exposed database port.

### 8.2 Privilege Boundary (Runtime vs. Migration)

The application must never run its normal request-handling workload as a database superuser or as a role that can alter schema, create/drop roles, or create databases. Two separate credentials are used:

- `MIGRATION_DATABASE_URL` — an owner-level role, used only to run `node-pg-migrate` (schema changes: `CREATE`/`ALTER`/`DROP TABLE`, etc.). Never used by the running API process.
- `DATABASE_URL` — the runtime role the API process actually connects as. Grants are limited to `SELECT`, `INSERT`, `UPDATE`, `DELETE` on application tables and `USAGE`/`SELECT` on sequences. It must not have `SUPERUSER`, `CREATEDB`, or `CREATEROLE`, and must not be able to `CREATE`/`ALTER`/`DROP` any table.

`scripts/provision-db-roles.sql` contains the exact `GRANT`/`REVOKE` statements to create and lock down the runtime role against a fresh schema. Run it once per environment, as the owner role, after migrations have created the schema. It also revokes the default `CREATE` privilege that PostgreSQL grants to `PUBLIC` on the `public` schema, and includes a verification query (`has_schema_privilege`/`has_table_privilege`) to confirm the runtime role's effective privileges after provisioning. See `docs/DECISIONS.md` for the reasoning.

---

## 9. Evidence & Document Storage

- `StorageService` (`src/shared/storage/storage-service.js`) selects its provider from `STORAGE_PROVIDER`: `local` (disk, outside any static/public web root — dev/test/single-instance demo only) or `supabase` (Supabase Storage private bucket, accessed via the REST API with the service-role key; no new SDK dependency). Files are never served through a static mount — access always goes through an authenticated, authorized backend endpoint.
- Production configuration validation (`validateProductionConfig` in `src/config/env.js`) refuses to start with `STORAGE_PROVIDER=local` unless explicitly overridden to `local-single-instance-accepted-risk`, so a production deploy can't silently end up with non-durable, single-instance-only file storage.
- Supabase credentials (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`) are variable names only in `.env.example`; no real Supabase project has been connected as part of this fix pass. `SUPABASE_SERVICE_ROLE_KEY` must never reach frontend code.
- Departure/return evidence descriptors returned to Admin/Site Manager on the Gate Pass detail endpoint are metadata only (file id, odometer, timestamp, recorded-by name) — never a storage path or URL. The actual bytes are only reachable through the existing authorized `GET /gate-passes/:id/files/:fileId` endpoint, which re-checks scope and file ownership itself.
- Every `SupabaseStorageProvider` call (upload/download/delete) is bounded by `SUPABASE_STORAGE_TIMEOUT_MS` (default 10000, validated 1000-120000) via `AbortController` — a network/storage outage aborts the request instead of holding it (and any DB transaction/row lock a caller holds alongside it, e.g. PDF finalization — see `docs/DECISIONS.md`) open indefinitely. A timeout raises a typed `StorageTimeoutError`, distinguishable from a plain HTTP/network failure. `SUPABASE_URL` and `SUPABASE_STORAGE_BUCKET` are validated at provider construction (valid URL; a plain, unambiguous bucket name — no path-traversal characters) in every environment, not just production.

---

## 10. QR Verification Token Lifecycle

- The verification token travels as a URL **fragment** (`#token`), never in a path segment or query string, and is submitted to the backend in a POST body — fragments are never sent to the server by the browser and don't land in server access logs or `Referer` headers.
- The frontend strips the token from the address bar via `window.history.replaceState` immediately after reading it (`src/modules/guard/pages/GuardVerifyPage.jsx`), so it does not persist in browser history if the page is later bookmarked or shared.
- Only a hash of the token is stored server-side (`verification_token_hash`); the raw token is also erased from the durable outbox job payload once the approval PDF has been generated, so it does not linger in the database any longer than necessary.
- The raw token is never written to localStorage/sessionStorage.

---

## 11. Site-Scoped Notification Delivery

- Every notification-outbox row carries an authoritative `recipient_site_id`, derived server-side from the Gate Pass it concerns — never trusted from a frontend-supplied filter. In-app notification listing requires either an exact `recipient_user_id` match or a `(recipient_role, recipient_site_id)` match; a Guard at one site cannot see another site's approval notifications by manipulating a query parameter.
- Outbox delivery is safe under worker crashes and cancellations: jobs are claimed atomically (`FOR UPDATE SKIP LOCKED`), a crashed worker's claim expires after a lease and becomes reclaimable, and cancelling a Gate Pass voids any still-pending delivery in the same transaction as the cancellation, plus a defense-in-depth re-check (`registerEntityRecheckHandler`) before a worker actually sends or generates a document — a Gate Pass cancelled after approval but before the worker runs cannot still produce a PDF or WhatsApp message.

---

## 12. Initial Admin Provisioning

There is no self-registration endpoint and no default/hardcoded admin account shipped with the system — a fresh database has zero users.

The first ADMIN account for a new deployment is created with:

```
npm run user:create-admin
```

run server-side (a Render Shell session or a one-off job against the target database), never through the browser. It supports two modes:

- **Interactive**: run with no relevant environment variables set; it prompts for email, full name, and site code (visible), then the password — read with terminal echo suppressed via raw-mode stdin (no masking dependency added; falls back to a plain line read when stdin isn't a real terminal, e.g. when piped).
- **Non-interactive**: set `ADMIN_EMAIL` and `ADMIN_FULL_NAME` (and optionally `ADMIN_SITE_CODE`, default `MAIN`) as environment variables. The password can be supplied either as `ADMIN_PASSWORD` or piped via stdin — see the exact procedure below.

The script (`scripts/create-admin-user.js`) requires migrations to have already run (it looks up the `ADMIN` role and the target site by code, both seeded by migrations), rejects a password under 12 characters, refuses to run if the email already exists rather than silently resetting it, and refuses to run against a **deactivated** site or a deactivated `ADMIN` role rather than silently provisioning into a site/role nobody can actually use.

**Secure production bootstrap procedure:**

1. Run migrations first (`npm run migrate:up:prod`) — the `ADMIN` role and target site row must already exist.
2. Set `ADMIN_EMAIL` and `ADMIN_FULL_NAME` (and `ADMIN_SITE_CODE` if not `MAIN`) through your platform's own environment-variable injection (e.g. a Render one-off Job's "Environment" tab) — never typed inline on a command line, where they would land in shell history.
3. Supply the password by piping it into the script rather than as an env var typed on a command line, so the secret itself never appears in shell history or a `ps` listing of the command:
   ```
   printf '%s' "$SECRET_PASSWORD" | node scripts/create-admin-user.js
   ```
   (An `ADMIN_PASSWORD` env var is still supported and is fine when your platform's own env var injection is itself secret-safe — the risk is specifically typing the value inline on a command line.)

There is currently no in-app user-management UI/API for creating additional users of any role — every user account (not just the first admin) is provisioned server-side for now. This is a known gap for a real multi-user rollout, tracked as future work, not a security control to route around by adding a public registration endpoint.