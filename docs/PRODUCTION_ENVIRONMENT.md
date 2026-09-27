# Production environment specification

What a fresh, company-owned ESDMS production environment needs. Derived from
the source (`backend/src/config/env.js`, `backend/src/shared/storage/`,
`backend/scripts/`, `frontend/src/core/config/env.js`, `render.yaml`) at the
approved release (48 migrations). **Nothing here has been created yet.**
Values below are formats only — never real values.

The old `esdms-api-test` / `esdms-app-test` Render services and the
`esdms-demo` Supabase project are **legacy demo, not production**; do not reuse
them (see [PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md)).

## 1. Target architecture

| Piece | Owner | Notes |
| --- | --- | --- |
| Source | Company GitHub `E-SET-DIGITAL/esdms` | Deploy an approved commit on `main` |
| Database + Storage | New dedicated company Supabase project | Never the Digital Permit System project |
| API | New company Render web service | Node, `rootDir: backend` |
| Frontend | New company Render static site | `rootDir: frontend`, same-origin `/api/v1` proxy |
| Domains | Company DNS, one registrable domain | e.g. `app.eset.pk` (frontend) and `api.eset.pk` (API) |

## 2. Database identities (verified against `scripts/release-database.js`)

| Identity | Used by | Where it lives |
| --- | --- | --- |
| Schema/migration owner (Supabase `postgres`-level owner) | `npm run db:release` only, as `MIGRATION_DATABASE_URL` | Operator machine / release job only |
| `esdms_runtime` (restricted login) | The API, as `DATABASE_URL` | Render API environment |

`db:release` refuses to run unless `DATABASE_URL` uses `esdms_runtime`,
`MIGRATION_DATABASE_URL` does **not**, both target the same host/port/database,
and `ESDMS_RUNTIME_PASSWORD` equals the password inside `DATABASE_URL`
(minimum 16 characters). It then: applies migrations as the owner → runs
`scripts/provision-db-roles.sql` (creates/rotates `esdms_runtime`, grants,
RLS, function hardening, provisioning marker) → verifies the runtime serving
contract as `esdms_runtime`.

The API must **never** run as `postgres`, the migration owner, or any
superuser/`BYPASSRLS` role. Readiness (`/api/v1/health/ready`) checks this and
reports not-ready otherwise.

**Supabase service-role key:** the API also holds `SUPABASE_SERVICE_ROLE_KEY`,
used **only** for the Supabase Storage REST API (private bucket). Database
access never uses it. It must never reach the frontend, logs or docs.

## 3. Environment variable matrix

Legend — Secret: **S** = secret, `-` = not secret. Owner: **Ops** = company
operator/IT, **Dev** = release engineer.

### DATABASE

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Render API; also operator for `db:release` | Required | Runtime connection as `esdms_runtime` | `postgresql://esdms_runtime:<password>@<host>:<port>/<db>` | S | Ops |
| `MIGRATION_DATABASE_URL` | Operator/release job **only** | Required for release | Schema owner for migrations/provisioning | `postgresql://<owner>:<password>@<host>:<port>/<db>` | S | Ops |
| `ESDMS_RUNTIME_PASSWORD` | Operator/release job **only** | Required for release | Password set/rotated on `esdms_runtime`; must match `DATABASE_URL` | ≥16 random characters | S | Ops |
| `DATABASE_POOL_MAX` | Render API | Optional (10) | Pool size (1–100) | integer | - | Dev |
| `DATABASE_CONNECTION_TIMEOUT_MS` | Render API | Optional (5000) | Connect timeout | integer ms | - | Dev |

Use the same Supabase endpoint (direct or pooler) for both database URLs.
The operator machine/release job needs Node.js (per `backend/package.json`
engines), `npm ci` in `backend/`, and the PostgreSQL `psql` client, which
`db:release` spawns for role provisioning.

### AUTH / JWT

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `JWT_SECRET` | Render API | Required | Session token signing | ≥32 random characters, fresh for production | S | Ops |
| `JWT_EXPIRES_IN` | Render API | Optional (`8h`) | Normal session lifetime | e.g. `8h` | - | Dev |

### ORIGINS / COOKIES

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `FRONTEND_ORIGIN` | Render API | Required | CORS allowlist (credentials) | `https://app.eset.pk` (bare https origin; comma-separated if several) | - | Dev |
| `APP_PUBLIC_URL` | Render API | Optional (defaults to first `FRONTEND_ORIGIN`) | Frontend base used in Gate Pass QR links | `https://app.eset.pk` | - | Dev |
| `API_PUBLIC_URL` | Render API | Required in production | API's own public origin; startup check that API and frontend are same-site | `https://api.eset.pk` | - | Dev |
| `COOKIE_DOMAIN` | Render API | Optional — **leave unset** | Only for deliberately sharing the session across subdomains | unset | - | Dev |

### PROXY / HOSTING

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | Render API | Required | Enables production validation, `Secure` cookies | `production` | - | Dev |
| `TRUST_PROXY_HOPS` | Render API | Required in production | Proxy hops in front of the API (client IP for rate limiting) | `1` on Render (verify after go-live) | - | Dev |
| `HOST` / `PORT` | Render API | Leave unset | Production defaults to `0.0.0.0`; Render supplies `PORT` | — | - | — |
| `BUILD_REVISION` | Render API | Optional | Revision shown in System/readiness (Render commit is used if unset) | commit SHA | - | Render |

### STORAGE / SUPABASE

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `STORAGE_PROVIDER` | Render API | Required | Primary/legacy file store | `supabase` (production refuses `local`) | - | Dev |
| `SUPABASE_URL` | Render API | Required with `supabase` | Project URL for Storage REST | `https://<project-ref>.supabase.co` | - | Ops |
| `SUPABASE_SERVICE_ROLE_KEY` | Render API | Required with `supabase` | Storage API authentication only | Supabase service-role key | S | Ops |
| `SUPABASE_STORAGE_BUCKET` | Render API | Required with `supabase` | Private bucket name | e.g. `esdms-private` (`[A-Za-z0-9._-]`) | - | Ops |
| `SUPABASE_STORAGE_TIMEOUT_MS` | Render API | Optional (10000) | Per-operation timeout (1000–120000) | integer ms | - | Dev |
| `STORAGE_DIR` | — | Not used in production | Local-disk storage path (dev/test) | — | - | — |

### CLOUD STORAGE (company Dropbox later; leave unset at go-live)

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `CLOUD_STORAGE_MASTER_KEY` | Render API | Optional; required before any provider credentials | Encrypts stored OAuth tokens | base64 of 32 random bytes (`openssl rand -base64 32`); back it up securely | S | Ops |
| `CLOUD_STORAGE_KEY_VERSION` | Render API | Optional (`1`) | Key version label | `1` | - | Dev |
| `CLOUD_STORAGE_OAUTH_ORIGIN` | Render API | Optional | OAuth callback origin = **frontend** origin (via the `/api/v1` proxy) | `https://app.eset.pk` | - | Dev |

### DROPBOX (optional, post go-live)

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `DROPBOX_CLIENT_ID` | Render API | Optional | Company Dropbox app key | app key | - | Ops |
| `DROPBOX_CLIENT_SECRET` | Render API | Optional | Company Dropbox app secret | app secret | S | Ops |

Register callback `https://app.eset.pk/api/v1/cms/cloud-storage/dropbox/callback`.
**Never copy the personal QA Dropbox connection or any QA token records.**

### GOOGLE DRIVE (unconfigured — live verification deferred)

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `GOOGLE_DRIVE_CLIENT_ID` | Render API | Leave unset | OAuth client | — | - | — |
| `GOOGLE_DRIVE_CLIENT_SECRET` | Render API | Leave unset | OAuth secret | — | S | — |

### WHATSAPP (disabled at go-live — deferred)

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `WHATSAPP_ENABLED` | Render API | Set `false` | Keeps delivery in safe non-delivery mode | `false` | - | Dev |
| `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_IPO_DESTINATION`, `WHATSAPP_DEPARTMENT_DESTINATION`, `WHATSAPP_API_BASE_URL`, `WHATSAPP_API_VERSION` | Render API | Leave unset | Meta Cloud API (future) | — | token: S | — |

### OTHER

| Variable | Location | Req. | Purpose | Format | Secret | Owner |
| --- | --- | --- | --- | --- | --- | --- |
| `APP_TIMEZONE` | Render API | Optional (`Asia/Karachi`) | Business timezone (numbering, display) | IANA zone | - | Dev |
| `ESDMS_ORIGINAL_CEO_EMAIL` | Operator only | Required for any reset tool use | Identifies the permanent CEO the reset must preserve | email | - | Ops |
| `CEO_EMAIL`, `CEO_FULL_NAME`, `CEO_SITE_CODE` | Operator only, during bootstrap | Required for `user:create-ceo` (or prompted) | CEO bootstrap input; password via hidden prompt | email / name / `MAIN` | - | Ops |

### Frontend (Render static site, build-time)

| Variable | Req. | Purpose | Format | Secret |
| --- | --- | --- | --- | --- |
| `VITE_API_URL` | Required (build fails without it) | API base the browser calls | `https://app.eset.pk/api/v1` (same-origin proxy) | - (public) |
| `VITE_APP_TIMEZONE` | Optional | Must match `APP_TIMEZONE` | `Asia/Karachi` | - |
| `VITE_BUILD_REVISION` | Optional | Revision label (`[A-Za-z0-9._-]`) | commit SHA | - |

Frontend variables are compiled into public JavaScript: **never put a secret in
any `VITE_*` variable.**

## 4. Domain / cookie / CORS contract (verified in source)

- Session cookie `esdms_session`: `HttpOnly`, `SameSite=Lax`, `Secure` in
  production, `Path=/`, **host-only** unless `COOKIE_DOMAIN` is set.
- CORS: only origins in `FRONTEND_ORIGIN`, with credentials.
- Production startup refuses to run unless `FRONTEND_ORIGIN` and
  `API_PUBLIC_URL` are bare `https://` origins on the **same registrable
  domain** (Public Suffix List).
- Why not `*.onrender.com`: `onrender.com` is a public suffix, so two Render
  hostnames are different sites; a `SameSite=Lax` cookie is not sent between
  them, and the startup check rejects that pairing.

**Recommended arrangement:**

| Setting | Value |
| --- | --- |
| Frontend | `https://app.eset.pk` (static site, SPA fallback, `/api/v1/*` rewrite to the API) |
| API | `https://api.eset.pk` (custom domain on the Render web service) |
| `VITE_API_URL` | `https://app.eset.pk/api/v1` |
| `FRONTEND_ORIGIN` / `APP_PUBLIC_URL` / `CLOUD_STORAGE_OAUTH_ORIGIN` | `https://app.eset.pk` |
| `API_PUBLIC_URL` | `https://api.eset.pk` |
| `COOKIE_DOMAIN` | unset |
| `TRUST_PROXY_HOPS` | `1`, then verify client IPs in logs/rate limiting behind the proxy |

The same-origin proxy is what the cloud-storage OAuth callback expects. A
direct browser→`api.eset.pk` arrangement (`VITE_API_URL=https://api.eset.pk/api/v1`)
also satisfies the cookie/CORS checks, but Dropbox connection would then need
its callback registered accordingly; keep one arrangement and document it.

## 5. Supabase Storage

- **Bucket:** create one **private** bucket (e.g. `esdms-private`) manually in
  the new project; the application does not create buckets. Leave it private.
  No public policies are needed: the API uses the service-role key server-side.
- **Behaviour:** every upload/download goes through authenticated, authorized
  API endpoints (site/department/role checks, anti-IDOR). The frontend never
  receives bucket URLs, signed URLs or keys.
- Supabase **database backups do not include Storage objects**; back up the
  bucket separately (see the runbook).

## 6. Render services (new; do not reuse `*-test`)

**Backend web service** (from `render.yaml`, renamed for production):

| Setting | Value |
| --- | --- |
| Repository / branch | `E-SET-DIGITAL/esdms`, `main` (deploy an approved commit) |
| Runtime / root | Node, `backend` |
| Build / start | `npm ci` / `npm start` |
| Health check | `/api/v1/health/ready` (not `/health`) |
| Plan | Paid, always-on (free instances sleep) |
| Region | Closest available to the Supabase region; decide together |
| Auto-deploy | Off; deploy approved commits manually |
| Pre-deploy command | None — never run migrations on API start; use `db:release` |

**Frontend static site:**

| Setting | Value |
| --- | --- |
| Repository / branch | `E-SET-DIGITAL/esdms`, `main` |
| Root / build | `frontend`, `npm ci && npm run build` |
| Publish directory | `dist` |
| Rewrites | `/api/v1/*` → `https://api.eset.pk/api/v1/*`; then `/*` → `/index.html` (SPA; QR links land on `/guard/verify`) |
| PWA | Service worker is built into `dist`; after each release users get the new version on next load |

## 7. Permanent CEO bootstrap

- Supported mechanism: `npm run user:create-ceo` from `backend/`, run by the
  operator with `DATABASE_URL` for the production database (the loaded config
  also needs `JWT_SECRET` and `FRONTEND_ORIGIN` present). Inputs:
  `CEO_EMAIL`, `CEO_FULL_NAME`, optional `CEO_SITE_CODE` (`MAIN`); the password
  is read from a hidden prompt — never pass it as an argument or env value in
  shell history.
- There is no API path that creates a CEO. Every CEO-role account is protected
  from governance actions (role change, deactivation, overrides).
- **Password (company decision):** the operator enters a strong,
  CEO-approved password at the hidden prompt; it may be the CEO's long-term
  password. The bootstrap intentionally does **not** force a password change
  at first login (unlike HR-created employee logins); the CEO can change it
  voluntarily at any time at `/change-password`. Never store or send the
  password in Git, documentation, tickets, logs or chat; keep it only in the
  company password manager if it must be recorded.
- Record the CEO email as `ESDMS_ORIGINAL_CEO_EMAIL` in the company's
  secure operations record.

## 8. Company structure bootstrap (what migrations create)

| Item | Created automatically | Configured after login | Notes |
| --- | --- | --- | --- |
| Site | Yes — `MAIN` "E-Set — Main Site" | Name change is release-managed | Multi-site model preserved |
| Departments | Yes — Administration, Civil, WTG, HSE, Procurement, HR; also legacy seeds Electrical, Mechanical, Warehouse | Deactivate unused ones in CMS → Organization | Never re-insert existing names |
| Positions | Yes — 17 company positions (Team Leads, Site Manager, CFO, CTO, HR Staff, Procurement Staff, etc.) | Add/edit in CMS | Positions grant no authority |
| Roles | Yes — CEO, Upper Management, HR, Employee, Site Administrator, Site Manager, Team Lead, Gate Keeper (`GATE_GUARD`) | — | |
| Permissions | Yes | Labels/help only (Permission Catalog) | Enforcement is in code |
| Capability bundles | Yes — Procurement Staff, Formal / Financial Approver | Assign in Users & Access | |
| CMS settings / branding defaults | Yes | Set in CMS → Branding / Content | See §9 |
| CEO | No | `user:create-ceo` (§7) | Exactly one permanent CEO |
| Site Manager, HR, Team Leads | No | Employees → login → role | Real staff only |
| Procurement users, Formal Approvers | No | Assign the bundle to the chosen users | Keep separate |
| Gate Keepers | No | Role `GATE_GUARD` ("Gate Keeper") | |

No test or operational users are created by migrations.

## 9. Branding (company decision required)

- Issuer name default is **"E-Set Engineering Services"**. The legal name may
  need to be **"E-STRATEGIC ENGINEERING TECHNOLOGIES (Pvt.) LIMITED"** —
  **handover configuration decision**; set it in CMS → Branding (not in code).
- Logo: upload the real E-Set logo in CMS (PNG/JPEG, ≤2 MB, 32–4096 px),
  tightly cropped, transparent/light background. A bundled real E-Set logo is
  the default until then.
- Company contact details: CMS → Branding (optional line on new documents).
- Branding affects new documents only.

## 10. Cloud storage at go-live

Start with Supabase private storage only. Leave `CLOUD_STORAGE_*`,
`DROPBOX_*` and `GOOGLE_DRIVE_*` unset. Later, the company Dropbox can be
connected in CMS → Integrations; activation affects future writes only and
existing files keep their provider. Never copy QA/personal connections, tokens
or file references into production.
