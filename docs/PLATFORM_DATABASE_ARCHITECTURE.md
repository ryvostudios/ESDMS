# Platform database architecture (ESDMS + Digital Permit + Attendance)

**Status: architecture contract (Phase 0). Nothing here is implemented.**
The phased execution plan is [PLATFORM_MIGRATION_PLAN.md](./PLATFORM_MIGRATION_PLAN.md).
Where this document and the code of a repository disagree, the code and its
migrations win; update this document.

## 1. Goal and principle

Three applications share **the existing company ESDMS Supabase/PostgreSQL
project** (already created and already serving the deployed ESDMS
environment) while remaining **logically independent**. No new Supabase
project is created: two isolated schemas, `permit` and `attendance`, are
added to the existing project, only after the existing ESDMS database has been
backed up and verified.

| Application | Repository | Schema | Runtime role | Migration ledger |
| --- | --- | --- | --- | --- |
| ESDMS | `eset-digital-management-system` | `public` (unchanged) | `esdms_runtime` | `public.pgmigrations` (node-pg-migrate) |
| Digital Permit | `e-set-digital-permit-system` | `permit` | `permit_runtime` (+ `permit_privileged`) | `permit.schema_migrations` |
| Attendance | `eset-attendance` (app + K-50 agent) | `attendance` | `attendance_runtime` | `attendance.schema_migrations` |

Shared: the PostgreSQL cluster, the backup schedule, the Supabase project
billing/owner. **Not shared:** schemas, runtime roles, users/sessions, secrets,
migration ledgers, migration identities, storage buckets, deploy pipelines.

One application must never read or write another application's schema. No
cross-schema foreign keys, views or functions in phase 1 (§14). Integration,
if ever needed, goes through an application API, not the database.

## 2. Current state (baseline, 2026-09-25)

**Canonical source repositories** (edit only these):

| Application | Canonical repository | Baseline |
| --- | --- | --- |
| ESDMS | `/Users/ashar/Projects/eset-digital-management-system` | `main` @ `53b129f` |
| Digital Permit | `~/Desktop/E-SET/DMS/e-set-digital-permit-system` | `main` @ `10f5b95` |
| Attendance | `~/Desktop/E-SET/DMS/eset-attendance` | `master` @ `3fef4ef` |

The ESDMS recovery copy/archive under `~/Desktop/E-SET/DMS/` is a **backup
only**, not a development source of truth; never edit both ESDMS copies. The
Permit and Attendance working trees contain CRLF line-ending noise only (no
semantic change); it is not normalized or committed by this programme.

**Deployment state:** the company ESDMS Supabase/PostgreSQL project and the
ESDMS deployment already exist. Their exact configuration (plan, backups,
roles, exposed Data API schemas, migration level, Render services) is
inventoried read-only in migration-plan Phase 1 before anything is added.

**ESDMS** — Node/Express API + React/Vite PWA. 47 node-pg-migrate migrations
in `public`, ledger `public.pgmigrations`. `npm run db:release` = migrate →
`provision-db-roles.sql` (psql) → verify runtime. API connects as
`esdms_runtime` (LOGIN, NOBYPASSRLS, no ownership, no DDL); every table has
RLS enabled and an `esdms_runtime_access` policy. Own auth: Argon2id, JWT in
an `esdms_session` HttpOnly SameSite=Lax cookie, `session_version`
revocation. Supabase is used for PostgreSQL and **Storage via the
service-role key** (REST only). Company-cloud Dropbox/Google OAuth
integrations are ESDMS features and are **out of scope** (unchanged).
Object inventory in `public`: 70 tables, 1 sequence, 51 functions,
52 triggers, 286 indexes.

**Digital Permit** — TypeScript/Express API + React frontend. 38 plain-SQL
migrations applied to `public` of its own Supabase project, ledger
`schema_migrations` (created **unqualified** by `backend/src/db/migrate.ts`,
advisory lock `7298183340`). Roles: `app_runtime` (LOGIN **BYPASSRLS**; RLS
is enabled with no policies), `privileged_runtime` (EXECUTE on one SECURITY
DEFINER function, via `PRIVILEGED_DATABASE_URL`), migration owner.
**Supabase Auth** provides identity: frontend sign-in/session, backend
`auth.getClaims`, Auth Admin for account creation and CEO bootstrap;
`app_user_access` (`state`, `must_change_password`,
`credentials_changed_at`) is the account-state boundary. Documents are in
private Storage via S3-compatible keys (independent of Auth). Migration 0022
already revokes `service_role` write access on privileged tables.

**Attendance** — Node `node:sqlite` (`attendance.db`), Express bound to
127.0.0.1, CORS `origin:true`. A Python pyzk agent (`k50-agent/`) reads the
ZKTeco K-50 on the LAN (port 4370) and posts events over HTTP with header
`x-attendance-agent-key`. Deduplication by SHA-256 `event_key`; timestamps
stored as ISO text with `+05:00`; business day in Asia/Karachi; Excel export
via ExcelJS.

## 3. Collision inventory

Compared ESDMS `public` objects (live local schema at 47/47) against every
object created by Permit migrations 0001–0038:

| Kind | Collisions |
| --- | --- |
| Tables | **`positions`** — ESDMS HR job positions vs Permit team positions (different meaning, different columns) |
| Sequences | none |
| Functions | none |
| Triggers | none |
| Indexes / constraints | none |
| Ledgers | none by name (`pgmigrations` vs `schema_migrations`), but Permit's ledger would land in `public` if left unqualified |
| Roles | none (`esdms_runtime` vs `app_runtime`/`privileged_runtime`), but Permit role names are generic and are renamed (§5) |

Attendance's SQLite schema has no PostgreSQL objects yet; it is designed
directly into `attendance`, so it cannot collide.

**Resolution:** schema separation resolves all collisions. No object is
renamed inside ESDMS. Permit's `positions` becomes `permit.positions`.

## 4. Target layout

```text
existing company ESDMS Supabase project (PostgreSQL)
├── public       ESDMS (existing, unchanged; 47+ migrations, pgmigrations)
├── permit       Digital Permit (tables, functions, permit.schema_migrations)
├── attendance   Attendance (tables, attendance.schema_migrations)
├── auth         Supabase-managed; not used by ESDMS; not used by Permit after its cut-over
└── storage      Supabase-managed; buckets per application (§12)
```

Rules:
- `permit` and `attendance` are **owned** by their application's migration role; nothing in them
  is owned by another application's role. ESDMS `public` ownership is unchanged.
- `REVOKE ALL ON SCHEMA permit, attendance FROM PUBLIC` (and from `anon`,
  `authenticated`, `service_role`) at creation.
- `permit` and `attendance` must **not** be exposed as Supabase Data API
  (PostgREST) schemas. All application access goes through each
  application's own backend API.
- Permit and Attendance roles get no access to ESDMS application tables in
  `public`, and vice versa.
- Every migration file schema-qualifies DDL or runs with a pinned
  `search_path` (§6). No migration relies on a default `public`.

## 5. Role matrix

| Role | LOGIN | BYPASSRLS | Owns | USAGE on | Data rights | Used by |
| --- | --- | --- | --- | --- | --- | --- |
| Supabase `postgres` | yes | yes | platform | all | all | break-glass only; creates the migration roles |
| existing ESDMS migration/operator identity (unchanged) | yes | — | `public` app objects | `public` | DDL | `db:release` from operator machine |
| `esdms_runtime` | yes | **no** | nothing | `public` | per-table grants + `esdms_runtime_access` policies | ESDMS API |
| `permit_migrator` | yes | no | schema `permit` + objects | `permit` | DDL | Permit migrator from operator machine |
| `permit_runtime` | yes | **no** | nothing | `permit` | per-table grants + per-table policies `TO permit_runtime` | Permit API |
| `permit_privileged` (only where required) | yes | no | nothing | `permit` | EXECUTE on the one SECURITY DEFINER function only | Permit privileged path |
| `attendance_migrator` | yes | no | schema `attendance` + objects | `attendance` | DDL | Attendance migrator |
| `attendance_runtime` | yes | **no** | nothing | `attendance` | per-table grants + policies (INSERT/SELECT only on raw events) | Attendance backend (the only writer for agent events) |
| `anon`, `authenticated` | Supabase | — | — | **none** on `permit`/`attendance` | none | — |
| `service_role` | Supabase | yes | — | **none** on `permit`/`attendance` | none there | ESDMS Storage REST only |

All application roles: `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
NOREPLICATION`, a `CONNECTION LIMIT`, and no membership in another
application's roles. A runtime role never owns a table (ownership bypasses RLS
unless `FORCE ROW LEVEL SECURITY`).

**Permit BYPASSRLS finding.** Permit's `app_runtime` is `BYPASSRLS` with RLS
enabled and no policies. `BYPASSRLS` is cluster-wide: in a shared cluster it
would bypass RLS on **every** schema the role can reach through grants,
including any mistaken grant on `public`. The contract therefore forbids
`BYPASSRLS` for all application roles. `permit_runtime` gets explicit
per-table policies (the ESDMS pattern: `CREATE POLICY permit_runtime_access
ON permit.<t> TO permit_runtime USING (true) WITH CHECK (true)`, narrowed
where tables are append-only), plus a verify step like ESDMS's
`verify-runtime`.

**service_role finding.** The ESDMS API holds the Supabase service-role key
for Storage. That key, via PostgREST, also bypasses RLS on exposed schemas.
Mitigation for the new schemas: do not expose them, and revoke
`service_role` on them. Restricting `service_role` on ESDMS `public` (or
moving ESDMS Storage to S3-scoped keys) is a **separate ESDMS assessment**,
not part of this migration.

## 6. search_path matrix

| Role | `search_path` (set with `ALTER ROLE ... SET`) |
| --- | --- |
| ESDMS migration/operator identity, `esdms_runtime` | unchanged (`public`) |
| `permit_migrator`, `permit_runtime`, `permit_privileged` | `pg_catalog, permit, pg_temp` (tested, Permit Phase 2) |
| `attendance_migrator`, `attendance_runtime` | `pg_catalog, attendance, pg_temp` |

`pg_catalog` comes first so no application object can shadow a built-in,
and `pg_temp` is listed last so a temporary object can never shadow an
application table. `public` is never on a Permit or Attendance path.

Additionally:
- Every SECURITY DEFINER function sets `search_path = pg_catalog, pg_temp`
  and schema-qualifies every application object it touches (for example
  `permit.privileged_access_events`). Invoker functions that rely on
  unqualified names pin `pg_catalog, <own schema>`.
- Extensions used by Permit (e.g. `gen_random_uuid()` is core in PG 13+;
  anything else) are referenced schema-qualified (`extensions.x`) where
  Supabase installs them outside `pg_catalog`.
- Application SQL should still schema-qualify where practical; the role
  default is defence in depth, not the only mechanism.

## 7. Authentication architecture

Each application owns its own identities. There is **no shared user,
permission or positions table** and no SSO in scope.

| | ESDMS | Permit (target) | Attendance (first PostgreSQL migration) |
| --- | --- | --- | --- |
| Human users | `public.users` (existing) | `permit.users` (new) | none added — current trusted/local boundary unchanged |
| Hash | Argon2id | Argon2id (legacy verify during transition, §9) | — |
| Session | JWT, `esdms_session` cookie, `session_version` | own HttpOnly cookie (e.g. `permit_session`), `session_version` | — |
| Machine auth | — | — | K-50 agent → `x-attendance-agent-key` (unchanged) |

ESDMS and Permit cookies have different names and are host-only (no shared
cookie domain), so one app's cookie is never sent to another app's host.
Secrets (JWT/session secrets, agent keys) are per-application and never
reused.

**Attendance authentication.** Attendance today is a localhost-oriented Node
backend, a local frontend/reporting flow, and the K-50 Python agent
authenticated by `x-attendance-agent-key`, with local SQLite. The storage
migration **preserves that working flow and security boundary**; it does
**not** add human user accounts or sessions. Before Attendance is exposed
beyond its current trusted/local boundary, remote human access
authentication and authorization must be **designed and tested as a separate
change** with its own review.

**Permit must not use `public.users`** and must not read ESDMS tables. A
person who uses both apps has two accounts.

`permit.users`:

```text
id                     uuid PK            -- equals the old auth.users.id (FK continuity)
email                  text NOT NULL      -- stored normalized (lower(btrim))
email_normalized_unique UNIQUE (email)    + CHECK (email = lower(btrim(email)))
password_hash          text NOT NULL      -- Argon2id, or legacy hash during transition
password_hash_scheme   text NOT NULL      -- 'argon2id' | 'legacy_supabase' (CHECK)
session_version        integer NOT NULL DEFAULT 1
state                  -- stays in app_user_access (single account-state boundary)
created_at, updated_at, password_changed_at timestamptz
```

`app_user_access` remains the account-state boundary (`state`,
`must_change_password`, `credentials_changed_at`); only its FK target changes
to `permit.users(id)`.

## 8. Permit Supabase Auth removal design

Current dependencies to replace:

1. **Frontend**: `AuthProvider.tsx`, `supabaseClient.ts` (sign-in, session,
   token refresh, `VITE_SUPABASE_*`).
2. **Backend middleware**: `middleware/auth.ts` (`auth.getClaims` bearer
   verification).
3. **Account admin**: account creation, password reset/change
   (`/auth/change-password`), CEO bootstrap (`scripts/bootstrapCeo.ts`
   `createUser`).
4. **Schema**: FKs to `auth.users` in migrations 0002, 0004, 0006, 0010,
   0012, 0013, 0015, 0016, 0017, 0019, 0023, 0035 (user, actor, signer,
   recipient, holder columns; PKs of `app_user_access`,
   `workforce_profiles`, `privileged_identities`).

Target:
- Backend endpoints `POST /auth/login`, `POST /auth/logout`,
  `GET /auth/session`, `POST /auth/change-password` issuing/clearing an
  HttpOnly, Secure, SameSite=Lax cookie; CSRF protection consistent with the
  cookie model; login rate limiting; generic failure messages.
- Middleware verifies the cookie, loads `permit.users` + `app_user_access`,
  checks `state` and `session_version` on every request.
- Account creation/reset/CEO bootstrap write `permit.users` directly
  (Argon2id); bootstrap keeps its current `must_change_password` semantics
  (Permit's own decision; unrelated to the ESDMS CEO decision).
- Every `auth.users` FK is re-pointed to `permit.users(id)` with the same
  `ON DELETE` behaviour. Because `permit.users.id` = old `auth.users.id`, no
  audit/lifecycle rows are rewritten.
- Frontend removes `@supabase/supabase-js` auth usage and all `VITE_SUPABASE_*`
  auth variables; calls the API with `credentials: 'include'`.
- Documents keep using S3-compatible Storage keys (unrelated to Auth).

Cut-over is one release: new auth code + FK re-point migration + user import
(§9). Rollback before cut-over is trivial; after cut-over see §17.

## 9. Password migration strategy

Constraints: hashes are **never printed**, logged, or copied to chat/docs;
plaintext passwords are never handled.

1. **At migration time** (not now), on the source Permit project, determine
   the hash scheme of `auth.users.encrypted_password` by inspecting only the
   **prefix class** in aggregate, e.g.
   `SELECT left(encrypted_password, 4) AS prefix, count(*) ... GROUP BY 1`
   (prints `$2a$`/`$2b$` and counts, not hashes). Expected: bcrypt.
2. **If bcrypt (or another scheme with a maintained, verified Node
   verifier):** copy `id`, normalized `email`, and the hash into
   `permit.users` with `password_hash_scheme = 'legacy_supabase'` inside the
   database (a single `INSERT ... SELECT` run by the operator between two
   databases via a secure dump of only those columns, never through logs).
   On successful login with a legacy hash: verify with the legacy verifier,
   immediately re-hash with Argon2id, set scheme `argon2id`, bump
   `password_changed_at`. Legacy verification code is removed once no
   `legacy_supabase` rows remain (or after a fixed deadline, after which
   remaining accounts are reset).
3. **If the scheme cannot be verified safely** (unknown prefix, mixed
   schemes, no trustworthy verifier, users without passwords/OAuth-only):
   **STOP.** Do not guess. Execute an explicit, approved **controlled
   password-reset plan**: import users with no usable hash, set
   `must_change_password = true`, and deliver one-time temporary passwords
   through the company's secure channel (as ESDMS does for new logins). This
   plan requires written approval before cut-over.
4. Email normalization conflicts (two auth users whose emails normalize to
   the same value) are a hard stop; resolve manually before import.

## 10. Attendance PostgreSQL design

Scope: a **storage adapter change** (SQLite → PostgreSQL) that preserves the
current HTTP/API contract used by the K-50 agent and the local frontend. The
tables are a direct translation of the current SQLite schema in
`backend/src/db/database.js` (no new business tables); exact columns are
fixed in migration-plan Phase 4 and checked against a copy of the real
`attendance.db` in Phase 7. Attendance-local reference tables (e.g. device
users/employees) have no FK to ESDMS tables.

The raw event table stays simple — **one append-only table**:
  - `event_key text PRIMARY KEY` — the existing SHA-256 key, **byte-for-byte
    preserved** (recomputing it would break deduplication with the agent's
    retries).
  - `occurred_at timestamptz NOT NULL`, plus `occurred_at_source text` (the
    original `+05:00` ISO string used in the key) so the key remains
    reproducible.
  - `device_id`, `device_user_id`, punch/verify type, `received_at`.
  - Insert with `ON CONFLICT (event_key) DO NOTHING` (idempotent retries).
  - Other raw input fields the agent sends are preserved where needed for
    audit or key reproduction.
  - UPDATE/DELETE revoked from `attendance_runtime`; trigger rejects them.
- Daily views/queries group by
  `(occurred_at AT TIME ZONE 'Asia/Karachi')::date`.
- Indexes: the unique `event_key`, `(device_user_id, occurred_at)`,
  `(occurred_at)`.
- **No partitioning initially.** Partitioning/archiving is an optional
  future growth path only (§15).

Backend change: `node:sqlite` → `pg` pool connecting as `attendance_runtime`.
Routes, request/response shapes, the agent header and key check, and the
local reporting/export flow stay the same. Hosting the backend beyond its
current local boundary (TLS, restricted CORS instead of `origin:true`, human
auth) is out of scope for the storage migration (§7).

## 11. K-50 preservation (agent path)

Unchanged topology principle: **the device and LAN are never exposed.**

```text
K-50 (LAN, port 4370) ← pyzk ← Python agent (company LAN)
     agent → authenticated HTTP API (x-attendance-agent-key)
           → Attendance backend → PostgreSQL `attendance` schema
```

- The Python agent keeps reading the K-50 locally and only calls the
  Attendance backend's authenticated HTTP API with `x-attendance-agent-key`
  (HTTPS whenever the backend is not on the same trusted host).
- The agent **never connects to PostgreSQL** and holds no database
  credential.
- Port 4370 and the device are never port-forwarded; no inbound access to the
  company LAN is required.
- The agent's code and `event_key` computation are unchanged; at most its
  configured API address and agent key change.
- Agent dependencies stay pinned (`pyzk==0.9`, `requests==2.34.2`,
  `python-dotenv==1.2.3`); upgrades are a separate change.
- Key rotation (when required): issue a new key, update the agent's
  environment file, retire the old key.

## 12. Storage isolation

| App | Bucket | Access path | Credential |
| --- | --- | --- | --- |
| ESDMS | `esdms-private` (+ Dropbox/Google per its CMS) | Storage REST | service-role key (existing; assessed separately) |
| Permit | `permit-private` | S3-compatible | S3 access key scoped to that bucket (Supabase S3 keys are project-wide; enforce via separate key, path policy and API authorization) |
| Attendance | none (exports are generated on request; add a private bucket with its own key only if persisted exports are ever needed) | — | — |

All buckets private. No application receives another's storage credential.
Object keys are never derived from user input without validation. Storage
objects are **not** part of database backups (§16).

Existing Permit objects are copied bucket→bucket with checksum verification;
object keys stored in `permit` rows are preserved so no row rewrite is needed.

**Decision: application database roles get no access to Supabase's managed
`storage` schema.** Permit's standalone backend reads `storage.buckets`
during its private-bucket readiness check. In the shared database
`permit_runtime` has neither BYPASSRLS nor any grant outside `permit`, so
that read returns nothing and document generation fails closed. This is a
known storage-phase blocker that must be resolved before the Permit
cut-over. The resolution is to check the Permit private bucket through
Permit's existing S3/storage interface, not to grant Permit database roles
access to `storage`. It is not implemented yet.

## 13. Migration ownership, ledgers and locking

- **No global ordered migration list.** Each application keeps its own
  migration directory, runner and ledger.
- Ledgers: `public.pgmigrations` (ESDMS, unchanged),
  `permit.schema_migrations`, `attendance.schema_migrations`. Runners
  create/read their ledger **schema-qualified**.
- Permit ledger change: `migrate.ts` qualifies `schema_migrations` as
  `permit.schema_migrations` (code change in migration-plan Phase 2, not
  now).
- Each runner connects as its own `*_migrator` and can only DDL its schema.
- **Serialization:** each runner already holds its own advisory lock
  (Permit `7298183340`; ESDMS node-pg-migrate's lock). Additionally every
  runner takes a shared **platform migration lock**
  `pg_advisory_lock(hashtext('eset-platform-migrations'))` for the duration
  of its run, so two applications never run DDL concurrently. Until the
  runners are changed, the operational rule is: **one migrator at a time**,
  recorded in the release log.
- Permit installation into `permit`: recommended as a **verified final-state
  baseline** migration (the schema at 0038, schema-qualified into `permit`,
  with the role/policy changes), recorded as baseline in
  `permit.schema_migrations`, rather than replaying 38 migrations written for
  `public`/Supabase roles. The old Permit database and its ledger remain the
  auditable history. The baseline is verified by a schema diff against a
  fresh 0038 replay (tables, columns, constraints, indexes, functions,
  triggers, grants), ignoring only the intended schema/role/FK changes.

## 14. Cross-schema references

Target for this programme:

- **No cross-schema business foreign keys.**
- **No unrestricted cross-schema SELECT** (no role has read access to
  another application's schema).
- **No shared positions, users or permissions tables.**
- No cross-schema views or functions.

Examples of what is not allowed: Permit referencing ESDMS employees,
Attendance referencing ESDMS employees, shared lookup tables. Any later
integration uses a deliberately reviewed, narrow interface (preferably an
application API) with its own decision record.

## 15. Scalability

- Expected volumes are small (hundreds of users, thousands of permits,
  attendance events ≈ employees × punches/day). One project handles this
  comfortably.
- Connection budget: each API uses a bounded pool (e.g. 5–10) against the
  Supabase pooler; per-role `CONNECTION LIMIT` prevents one app starving the
  others. Sum of pools stays below the plan's limit.
- `attendance_events` is the only unbounded-growth table. It starts as one
  indexed table; monthly partitioning or archiving of old events is an
  **optional** future growth path, only if measured size or query time
  justifies it, and needs no API change.
- If one application outgrows the shared project, its schema can be moved
  out with `pg_dump --schema=<app>` because there are no cross-schema
  dependencies.

## 16. Backup and restore

- Supabase project backups cover all three schemas at once (same point in
  time). Per-application logical dumps: `pg_dump --schema=permit` etc. as the
  relevant migrator, stored encrypted in company storage.
- Storage objects are backed up per bucket separately.
- Restoring one application: restore its schema dump into an isolated
  database, verify, then (with writers stopped) replace only that schema.
  Never restore the whole project to fix one application without approval
  from all three owners.
- Before every phase in the migration plan: project backup confirmed +
  logical dump of the affected schema(s) + source database untouched.

## 17. Deployment order and rollback

Order per application release: database release (migrator) → runtime verify →
API → frontend. Applications are released **independently**; a release of one
never requires a release of another.

ESDMS is already deployed on the shared project and is not re-released by
this programme. Order: backup and verify existing ESDMS → create `permit` and
`attendance` schemas/roles → Permit cut-over → Attendance cut-over (see
[PLATFORM_MIGRATION_PLAN.md](./PLATFORM_MIGRATION_PLAN.md)).

Rollback:
- Before data cut-over: drop the new schema and roles (they contain no live
  data) and keep using the source system.
- After data cut-over: **no down migrations**; roll back by pointing the
  application back to its **source environment**, which is kept read-only but
  intact (never deleted immediately), and reconciling any writes made in the
  new environment. Each phase in the plan defines its point of no return.
- Source databases/environments are retired only after acceptance and an
  agreed retention period.

## 18. Security invariants (must hold after every phase)

1. No application role has `BYPASSRLS`, `SUPERUSER`, `CREATEROLE` or
   `CREATEDB`.
2. Every table in `permit`/`attendance` has RLS enabled and only policies
   `TO` its own runtime role.
3. `anon`, `authenticated`, `service_role` and `PUBLIC` have no privileges on
   `permit`/`attendance`; those schemas are not exposed via the Data API.
4. No runtime role owns objects or has privileges outside its schema.
5. No cross-schema FK, view or function.
6. After the Permit cut-over, Permit uses no Supabase Auth API and no
   `auth.*` object.
7. Password hashes and secrets are never printed, logged or committed.
8. The K-50 agent has no database credential; device and LAN have no inbound
   exposure.
9. Each application's secrets (DB passwords, session secrets, storage keys,
   agent keys) are distinct.
10. ESDMS behaviour, migrations 1–47, Dropbox/Google OAuth and
    `esdms_runtime` are unchanged by this programme.

## 19. Test gates

A phase is complete only when:
- ESDMS: backend and frontend suites green; readiness reports the current
  migration count with no problems, before and after the new schemas are
  added.
- Permit: backend (≈1514) and frontend (≈658) suites green; E2E green (needs
  `npx playwright install chromium` on the test machine); new role-matrix
  verify script green.
- Attendance: its suites green; event-key parity test (same input → same key
  in SQLite and PostgreSQL); idempotent re-post test; agent API contract and
  local report/export output unchanged.
- Isolation tests (run as each runtime role): cannot `SELECT` from another
  schema; cannot DDL; cannot `SET ROLE` to another role; `service_role` and
  `anon` cannot read `permit`/`attendance`.
- Data migration: row counts and per-table checksums match source; sample
  logins succeed.

## 20. Non-goals

- No new Supabase project and no ESDMS re-deployment.
- No change to ESDMS auth, CEO bootstrap, migrations, OAuth integrations or
  storage providers.
- No human user authentication added to Attendance as part of the storage
  migration (§7).
- No shared users, SSO, or cross-application data.
- No redesign of Permit business workflows or Attendance business rules.
- No K-50 firmware/network changes; no direct device exposure.
- No line-ending normalization across repositories.
- No execution of any phase in Phase 0.
