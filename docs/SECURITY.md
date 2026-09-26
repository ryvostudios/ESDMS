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
- `POST /auth/change-password` also bumps `session_version` and clears the
  session cookie on success (`src/modules/auth/auth.controller.js`) —
  every previously issued token for that user, including the one used to
  make the request, is revoked, and a fresh login with the new password is
  required. See `docs/DECISIONS.md`'s "Pre-Pilot Security &
  Data-Integrity Hardening Pass" entry (ESDMS-020) for why this replaced
  the prior "same session continues" design.
- Authenticated requests are additionally rate-limited **per user id**
  (`apiUserRateLimiter`, applied in `authenticate.js` once `req.user` is
  known), separate from the broad per-IP ceiling (`apiRateLimiter`) applied
  to every request regardless of authentication — see ESDMS-017 in
  `docs/DECISIONS.md`. This keeps many employees sharing one site's IP from
  sharing one request budget.

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
`FRONTEND_ORIGIN`'s registrable domain (eTLD+1) doesn't match
`API_PUBLIC_URL`'s. The registrable domain is computed with
[`tldts`](https://www.npmjs.com/package/tldts) (`getDomain(hostname, {
allowPrivateDomains: true })`) against the real Mozilla Public Suffix
List — not a homemade "last two labels" heuristic, which gets
multi-label suffixes backwards (e.g. it would treat
`app.customer-a.com.pk` and `api.customer-b.com.pk`, two different
customers, as the same site, while correctly handling
`app.company.com.pk` / `api.company.com.pk`, the same customer, requires
knowing `.com.pk` itself is the suffix, not just the last two labels).
`allowPrivateDomains` also makes `tldts` treat PSL "private section"
entries — Render, Vercel, Netlify, Heroku, GitHub Pages, Fly.io, Railway,
etc. — as their own suffix, so two different customers' subdomains under
one of those are correctly rejected too, without this codebase
maintaining its own list of platform domains. `tldts` is a runtime
(production) dependency for exactly this reason — see
`docs/DECISIONS.md`.

Both `FRONTEND_ORIGIN` and `API_PUBLIC_URL` must additionally be a bare
`https://` origin in production — no path, query, fragment, or embedded
credentials (e.g. `https://app.example.com`, not
`https://app.example.com/path` or a URL with `user:pass@`). A browser's
CORS `Origin` header is always exactly scheme + host[:port]; a
`FRONTEND_ORIGIN` value carrying anything else could never actually match
one. `APP_PUBLIC_URL` gets the same requirement for a different reason —
it's used as a bare base that `/guard/verify` is appended onto for every
QR code link, so a value with its own path would produce a broken link.

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

### 6.1 Governance / User-Management Authorization

`src/modules/users/` (routes gated by `requirePermission`, e.g. `users.create`,
`users.update`, `users.activate`, `users.deactivate`, `permission_overrides.view`,
`permission_overrides.manage`) is the CEO/Upper-Management/HR governance layer
described in `docs/DECISIONS.md`. All CEO-protection and self-escalation
invariants are centralized in one place,
`src/modules/users/users.authorization.js`'s `guardGovernanceTarget` /
`guardUmCreateAuthority`, rather than re-derived per endpoint:

- **CEO accounts cannot be modified through this API** — by any actor,
  including another CEO — for role change, activation/deactivation, or
  permission overrides. CEO succession/management is deliberately out of
  scope for this increment; only `scripts/create-ceo-user.js` (terminal
  bootstrap) creates one, and `CEO` is excluded from the API's assignable-role
  enum entirely, so it is rejected at input validation before any service
  logic runs.
- **No actor can act on their own account** through any governance mutation
  endpoint (role change, activate/deactivate, permission grant/deny/remove) —
  closes self-escalation via a crafted payload and accidental self-lockout in
  one rule.
- **`UPPER_MANAGEMENT` as a role never implies UM authority.** Creating a user
  with that role, or changing a user's role to/from it, or touching an
  existing Upper Management account's role/active-state/permission overrides,
  additionally requires the specific `users.create_um` / `users.manage_um`
  permission — which only `CEO` holds by default (see the
  `governance-foundation` migration's seed data). A CEO can later delegate
  either to a specific UM member via a permission override; that delegation
  does not propagate to other UM members.
- A blocked attempt against any of the above is audited as
  `PRIVILEGE_ESCALATION_ATTEMPT` in `governance_audit_log` **before** the
  `403` is returned — a denied privileged request is never invisible.

Delegated governance is bounded by the actor's effective permissions. Existing
ordinary Employee role capabilities remain assignable through authorized user
management; other role/bundle permissions must be held by the delegate.
Governance, account-management and company-wide scope permissions cannot be
redelegated by non-CEO actors. Accounts holding these powers require CEO
administration. A delegate cannot replace or remove another actor's DENY.
Mutation targets are locked and rechecked for current site and protected status.
Workforce treats EMPLOYEE accounts with explicit grants or bundles as privileged
for credential reset, offboarding and automatic site synchronization.

Effective permissions (`role permissions + individual grants + active named
bundles - individual denials`, explicit denial always winning) are computed once, in
`getUserProfileById` (§8.2's `user_permission_overrides` table), and reused
unchanged by both `authenticate.js` (every request) and the governance
endpoints' own permission-overview response — there is no second,
potentially-diverging implementation of the rule.

Organization data never grants authority. In particular, an Administration
Department and a Team Lead Position are ordinary Workforce records and have no
foreign key or inference path to the `ADMIN`/`TEAM_LEAD` application roles.
The stable `ADMIN` code is displayed as **Site Administrator**. Procurement
Staff and Formal / Financial Approver are provenance-bearing named bundles,
not roles or Departments. Procurement record reach comes only from the
separate `procurement.site_scope` capability; `procurement.view_prices` can
reveal fields on an already-visible record but cannot widen site/department
scope.

**No session_version bump on role/permission/deactivation change.**
`authenticate.js` already calls `getUserProfileById` fresh on every request —
nothing about a user's role, permissions, or active state is cached in the
JWT (the `role` claim `auth.service.js` signs into the token is never read
back by `authenticate.js`; only `sub` and `sv` are). A role change, a
permission override, or a deactivation is therefore already enforced on the
very next request under the *same* still-valid session cookie — no re-login
required, and no window where a stale privilege set continues to work. This
is stronger than a `session_version` bump would provide (which would only
force a fresh login rather than fixing the current session's next request),
so none of the three trigger one; see `test/governance.test.js`'s
"reflected on the next request" tests and `docs/DECISIONS.md`.

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

The runtime pool is explicitly bounded by `DATABASE_POOL_MAX` and
`DATABASE_CONNECTION_TIMEOUT_MS`; saturation fails within a configured bound
instead of waiting indefinitely. Code already holding a transaction client must
thread that executor through every operation-owned query, including recipient
resolution and receiving lookups. Readiness verifies required physical schema
objects as well as `pgmigrations`, so a forged or stale ledger cannot make a
drifted database ready. It exposes no connection details, SQL, paths or errors.

- `MIGRATION_DATABASE_URL` — an owner-level role, used only to run reviewed `node-pg-migrate` schema changes and the post-migration provisioning script. It is never configured on, or used by, the running API process.
- `DATABASE_URL` — the `esdms_runtime` login used by the API process. It receives only the explicitly reviewed table privileges named in `scripts/provision-db-roles.sql`: most application tables receive CRUD, capability-bundle definitions are read-only, and bundle assignments deliberately omit `UPDATE`. That allowlist is authoritative and grows only when a migration adds a reviewed runtime dependency. Runtime also receives `USAGE` on `public` and `EXECUTE` on only the two narrow readiness functions. It has no sequence privileges, no privilege on `public.pgmigrations`, no schema `CREATE`, and must have `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `REPLICATION`, and `BYPASSRLS` all disabled.

The security migration `1787401000000_database-runtime-security-boundary.js` enables (but does not `FORCE`) RLS on all 13 current public tables and revokes table/sequence and applicable default privileges from Supabase's `anon` and `authenticated` roles when those roles exist. Browser clients therefore do not access ESDMS tables directly through Supabase Data APIs. RLS is an additional database boundary; authentication, permissions, site/department isolation, and workflow authorization remain enforced by the backend.

Supabase's `service_role` is **not** an ESDMS application database identity. ESDMS reads and writes its data only as `esdms_runtime`. The Supabase service-role key is a separate backend integration concern: the backend uses it only for the Supabase Storage HTTP API, which gives it no SQL authority over ESDMS objects. Supabase's default privileges would otherwise give `service_role` every table, sequence and function the migration owner creates in `public`, so `scripts/provision-db-roles.sql`, run by every `npm run db:release`, handles it in three ways:

- **Current objects:** it revokes all table (and column), sequence and function privileges on current objects, plus the direct schema grant.
- **Future objects:** it revokes the migration owner's global and `public` default privileges, so future ESDMS objects stay closed.
- **Verification:** the release fails unless `service_role` holds no effective privilege on any ESDMS-owned table, column, sequence or function, owns nothing directly or through a role it belongs to, and appears in none of the owner's default ACLs.

`public` keeps PostgreSQL's built-in `PUBLIC` USAGE. That permits only name lookup, is shared by every login in the database (including Supabase-managed roles whose needs cannot be verified outside a real Supabase project), and grants no object access. Supabase-managed schemas (`storage`, `auth` and others) are not touched.

The follow-up migration `1787402000000_public-function-execution-boundary.js` revokes `EXECUTE` on current public functions from `PUBLIC` and the browser roles, and removes both global and public-schema function defaults belonging to the migration owner. PostgreSQL trigger execution does not require the table caller to hold direct `EXECUTE` on the trigger function, so the API runtime receives no direct function grant. Future functions created by the migration owner therefore do not become publicly/browser executable by default.

The migration `1787403000000_workforce-permission-foundation.js` (Workforce module foundation — see the Workforce entry in `docs/DECISIONS.md`) adds a 14th public table, `user_permission_overrides`, and enables RLS on it directly in the same migration rather than deferring that to a later pass. `scripts/provision-db-roles.sql` grants it to `esdms_runtime` and converges the same `esdms_runtime_access` policy on it as every other application table.

The migration `1787404000000_governance-foundation.js` (governance/user-management foundation — see the corresponding `docs/DECISIONS.md` entry) adds a 15th public table, `governance_audit_log` — an append-only audit trail (same `forbid_update_delete()` trigger `gate_pass_audit_log` already uses) for user creation, role changes, activation/deactivation, permission grants/denials/removals, and blocked privilege-escalation attempts. RLS and the runtime grant/policy follow the same pattern as every prior table.

The migration `1787405000000_workforce-schema-foundation.js` (Workforce/Employee Management — see `docs/DECISIONS.md`) adds 22 more public tables (`positions`, `employment_types`, `employees`, `employment_assignments`, `temporary_assignments`, `employee_profile_photos`, `employee_personal_details`, `employee_emergency_contacts`, `employee_profile_sections`, `employee_custom_fields`, `employee_custom_field_values`, `employee_document_types`, `employee_documents`, `employee_document_requests`, `employee_compensation_records`, `employee_contract_number_counters`, `employee_contracts`, `rotation_policies`, `employee_rotation_ledger`, `leave_types`, `leave_requests`, `employee_business_history`), bringing the total to 36 (37 with `pgmigrations`). Every one gets RLS enabled in the same migration and the same runtime grant/policy in `scripts/provision-db-roles.sql`. Two of them carry additional DB-level protection beyond RLS:

- `employee_contracts` — a `BEFORE UPDATE` trigger (`employee_contracts_enforce_immutability`) rejects every change to a non-`DRAFT` row except the specific forward lifecycle status transitions (`CURRENT` → `SUPERSEDED`/`EXPIRED`/`TERMINATED`). Both effective dates are original terms and are immutable. A `BEFORE DELETE` trigger rejects deleting any row once it has left `DRAFT`. This is enforced for every actor, including CEO and direct SQL; download/finalization also re-hash stored bytes and compare SHA-256.
- `employee_compensation_records` — `BEFORE UPDATE OR DELETE` uses the append-only guard. Salary changes are new effective-dated records even if application code or a direct runtime query attempts an overwrite.
- `employee_documents` and `employee_profile_photos` — stored file identity/version/checksum columns are DB-immutable. Document verification fields remain the only permitted document update, and all download/export paths verify SHA-256 before serving bytes.
- `employee_business_history` — a `BEFORE UPDATE` trigger permits changing only the four logical-removal columns (`is_removed`, `removed_by_user_id`, `removed_reason`, `removed_at`); any other column change, or any `DELETE`, is rejected. CEO's history-removal capability is therefore a controlled, logged state change, never a real delete.

`governance_audit_log` (§6.1) was also widened (migrations `1787406000000_workforce-protected-audit.js` and `1787408000000_workforce-release-hardening.js`) with Workforce target columns and action codes including report export, bulk ZIP export, and completed XLSX import. The release-hardening migration adds no table: the boundary remains 36 application tables (37 including owner-only `pgmigrations`).

The migration `1787412000000_material-catalog-foundation.js` (Procurement & Material Receiving V1, Checkpoint 1 — see `docs/DECISIONS.md` and `docs/PROCUREMENT_RECEIVING_SPEC.md`) adds 3 more public tables (`units_of_measure`, `company_items`, `department_material_catalog`), bringing the total to 39 (40 with `pgmigrations`). Every one gets RLS enabled in the same migration and the same runtime grant/policy in `scripts/provision-db-roles.sql`; none carries additional DB-level protection beyond RLS — this checkpoint has no immutable/history table.

The migration `1787413000000_material-demand-foundation.js` (Procurement & Material Receiving V1, Checkpoint 2 — Department Demand List foundation, see `docs/DECISIONS.md` and `docs/PROCUREMENT_RECEIVING_SPEC.md`) adds 4 more public tables (`material_demand_number_counters`, `material_demands`, `material_demand_lines`, `material_demand_audit_log`), bringing the total to 43 (44 with `pgmigrations`). Every one gets RLS enabled in the same migration and the same runtime grant/policy in `scripts/provision-db-roles.sql`. `material_demand_audit_log` reuses the existing `forbid_update_delete()` trigger (same append-only guarantee as `gate_pass_audit_log`); `material_demands` reuses `forbid_delete()` and `set_updated_at()`. No new trigger function was introduced.

The migration `1787414000000_material-demand-initial-approval.js` (Procurement & Material Receiving V1, Checkpoint 3 — the first approval gate, see `docs/DECISIONS.md` and `docs/PROCUREMENT_RECEIVING_SPEC.md`) adds 1 more public table, `material_demand_approvals` (append-only via the existing `forbid_update_delete()` trigger — an approval decision is never editable, by anyone, including CEO), bringing the total to 44 (45 with `pgmigrations`). It also widens `material_demands_status_check` (adds `REJECTED`, `READY_FOR_PRICING`) and `material_demand_audit_log_action_check` (adds the four decision-outcome action codes plus `READY_FOR_PRICING`), and widens `material_demand_audit_log.action` from `varchar(20)` to `varchar(30)` to fit them. No new trigger function was introduced.

The migration `1787415000000_material-demand-procurement-pricing.js`
(Checkpoint 4) adds the financially isolated tables
`material_demand_pricing` and `material_demand_pricing_lines`, bringing the
total to 46 application tables (47 with owner-only `pgmigrations`). Both
have RLS enabled and explicit runtime allowlist/policy entries. Composite
foreign keys prevent a pricing line from referencing a Demand line outside
its header's Demand. Two `SECURITY INVOKER` trigger functions with pinned
`search_path` and no public/runtime direct execute grant protect submitted
headers and lines; the line guard locks its header so a direct write cannot
race finalization. Ordinary Demand queries do not join either table.

The migration `1787416000000_material-demand-final-pricing-approval.js`
(Checkpoint 5) adds no table or directly callable function, so the runtime
boundary was unchanged by it — 46 application tables (47 with owner-only
`pgmigrations`) as of that checkpoint. The per-migration totals in this
section are each accurate for the migration they describe; the current
boundary is whatever `scripts/provision-db-roles.sql` names, never a number
copied from here.

**Current boundary (informative).** The narrative above stops at Checkpoint 5.
Since then, IPO and purchasing, Delivery Challan, Receiving, line
dispositions, carry-forward allocation, procurement documents, capability
bundles and Fleet master data have each added tables, and the boundary is now
**64 application tables (65 with owner-only `pgmigrations`)**. That number is
recorded here only so a stale figure cannot be mistaken for the current one —
it is still not the authority.

The authority is now machine-checked in two places, so this section can no
longer drift silently:

- `backend/src/shared/db/runtime-access-contract.js` declares every table the
  running API may touch and with which privileges. A test asserts that it and
  `scripts/provision-db-roles.sql` name exactly the same tables with exactly
  the same privileges, and that every table the migrations create appears in
  it. Adding a table to one without the other fails CI.
- `/health/ready` verifies the live database against that same contract —
  schema USAGE, table privileges, RLS and the runtime row policies — and
  additionally executes the real authentication projection. An instance whose
  runtime role cannot actually serve reports not-ready instead of reporting a
  healthy schema (see §8.3).
It adds stage/version-aware partial unique indexes and a composite FINAL
approval foreign key binding Pricing id + Demand id + Demand revision.
Existing approval rows are preserved as `INITIAL`; existing Pricing headers
become Version 1. Submitted Pricing immutability and approval append-only
triggers remain in force. FINAL actions require both the relevant Demand
decision capability and `procurement.view_prices`; ordinary Demand responses
redact protected FINAL rejection reasons and never join price data. A
populated down migration refuses to destroy FINAL decisions or Version 2+
history.

The Workforce trigger functions (`employee_contracts_enforce_immutability`, `employee_contracts_forbid_finalized_delete`, `employee_business_history_guard`, and `employee_documents_guard_update`) are ordinary `LANGUAGE plpgsql` functions with no `SECURITY DEFINER` (same as the existing `forbid_update_delete()`/`forbid_delete()`) and an explicit `SET search_path = pg_catalog, public`. They receive no direct `EXECUTE` grant to application/browser roles and are invoked only through their table triggers.

PostgreSQL default ACLs are owner-specific: defaults owned by `supabase_admin` apply to objects subsequently created by `supabase_admin`, not to ESDMS objects created by the `postgres` migration owner. ESDMS removes and verifies the relevant global/public defaults belonging to its current migration owner; it does not alter or claim ownership of unrelated Supabase-managed defaults.

`scripts/provision-db-roles.sql` is the idempotent, post-migration environment-provisioning step. It reads `ESDMS_RUNTIME_PASSWORD` only after disabling psql query echoing, creates or rotates only the runtime login password, verifies dangerous role attributes instead of trying Supabase-incompatible `ALTER ROLE ... NOSUPERUSER/NOBYPASSRLS` operations, removes legacy broad/default grants owned by the migration role, hardens current and future public-function execution, grants its explicit table allowlist, and converges one `esdms_runtime_access` RLS policy on each runtime-accessible application table. There is intentionally no runtime policy or privilege on `public.pgmigrations`. The script records the reviewed provisioning version through a narrow `SECURITY INVOKER` function that is executable only by `esdms_runtime`; migrations cannot advance that marker by themselves.

The authoritative managed-environment entry point is `npm run db:release`, with
`MIGRATION_DATABASE_URL`, runtime `DATABASE_URL`, and
`ESDMS_RUNTIME_PASSWORD` supplied through the deployment platform's secret
environment. It executes, in order: migrations, this provisioning script, and
`npm run db:verify-runtime`. The verifier connects as `esdms_runtime`, checks
role/schema/table/function/sequence/ownership/RLS boundaries, executes the
exact login/`/me` profile query with a non-matching UUID, and probes the fleet
tables. It fails closed before application cutover.

For audited break-glass/manual provisioning, the underlying invocation is:

```sh
read -rs ESDMS_RUNTIME_PASSWORD
export ESDMS_RUNTIME_PASSWORD
psql --no-psqlrc "$MIGRATION_DATABASE_URL" -f scripts/provision-db-roles.sql
unset ESDMS_RUNTIME_PASSWORD
```

`--no-psqlrc` is mandatory because a user's `.psqlrc` runs before the script and could otherwise inspect exported environment variables. The combination of `--no-psqlrc`, script-level `\set ECHO none` before `\getenv`, and psql's quoted-variable form (`:'runtime_password'`) prevents the normal provisioning command from echoing the runtime password while preserving injection-safe SQL quoting. Arbitrary psql wrappers or invocations that inspect the environment are outside this guarantee.

Every new module/table requires a reviewed forward migration plus an explicit update to the runtime table allowlist and RLS policy provisioning. New directly callable database functions require an equally explicit reviewed grant. No migration-owner default privilege automatically exposes future tables, sequences, or functions to `esdms_runtime`, `anon`, or `authenticated`.

### 8.3 Readiness Verifies Serving Capability, Not Only Schema

Object existence and access privilege are independent facts, and readiness
used to check only the first. A migration that added a table without a
matching `provision-db-roles.sql` run left every object present and every
query denied: `/health/ready` reported `"ready"` with `schemaCompatible: true`
while `POST /auth/login` returned 500 with PostgreSQL `42501`. Revoking
`SELECT` on `users`, `roles`, `sites`, `departments` or `employees` all
reproduced it.

`/health/ready` now verifies four independent things and reports each
separately, so an operator can tell "the migration did not run" apart from
"the migration ran but provisioning did not". Readiness runs on the API's own
runtime connection, so `schemaCompatible: true` cannot by itself make the
endpoint healthy. It reports only non-secret versions and booleans, and never
repairs the database:

| Field | What it means |
| --- | --- |
| `schemaCompatible` | Migration ledger and load-bearing objects (columns, triggers, functions, indexes) |
| `runtimeAccessHealthy` | The connected role holds the schema/table privileges and, where it is subject to RLS, the row policies declared in `runtime-access-contract.js` |
| `authServingHealthy` | The REAL authentication profile projection executes — the same statement `/auth/login` and every authenticated request run |
| `runtimeProvisioningCompatible` | The privilege *boundary* is intact — the role inherits no other role, holds no grant beyond the reviewed set, can execute no unexpected function, and every policy has the exact intended shape — and `esdms_runtime_provisioning_version()` names the migration level currently deployed, so a stale or omitted provisioning run cannot pass |
| `ready` | All four. This is what drives the 200/503 |
| `problems` | Actionable, non-secret descriptions. Object and privilege names only — never driver text, SQL, or stack frames |

The provisioning marker is stamped by `provision-db-roles.sql` from the
migration ledger as it stood when provisioning ran, not from a hand-maintained
literal. A level that was never migrated to therefore cannot be stamped, and a
deployment that migrated without re-provisioning is refused rather than served.

The policy check is skipped for a role RLS could not constrain (a superuser,
`BYPASSRLS`, or a table's own owner without `FORCE RLS`), so a development
connection that owns the schema is not reported not-ready for policies that do
not apply to it. In production the API connects as the non-owner
`esdms_runtime`, where they do apply and are checked.

Readiness is a very good predictor that a user can sign in. It is not proof —
it runs the authentication query with a sentinel id, not a real credential, an
Argon2 verification, a JWT signature and a session cookie. The release
procedure therefore still requires a real login smoke test after deployment;
see `docs/OPERATIONS.md`.

---

## 9. Evidence & Document Storage

- `StorageService` (`src/shared/storage/storage-service.js`) selects its provider from `STORAGE_PROVIDER`: `local` (disk, outside any static/public web root — dev/test/single-instance demo only) or `supabase` (Supabase Storage private bucket, accessed via the REST API with the service-role key; no new SDK dependency). Files are never served through a static mount — access always goes through an authenticated, authorized backend endpoint.
- Production configuration validation (`validateProductionConfig` in `src/config/env.js`) refuses to start with `STORAGE_PROVIDER=local` unless explicitly overridden to `local-single-instance-accepted-risk`, so a production deploy can't silently end up with non-durable, single-instance-only file storage.
- Supabase credentials (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`) are variable names only in `.env.example`; no real Supabase project has been connected as part of this fix pass. `SUPABASE_SERVICE_ROLE_KEY` must never reach frontend code.
- Departure/return evidence descriptors returned to Admin/Site Manager on the Gate Pass detail endpoint are metadata only (file id, odometer, timestamp, recorded-by name) — never a storage path or URL. The actual bytes are only reachable through the existing authorized `GET /gate-passes/:id/files/:fileId` endpoint, which re-checks scope and file ownership itself.
- Every `SupabaseStorageProvider` call (upload/download/delete) is bounded by `SUPABASE_STORAGE_TIMEOUT_MS` (default 10000, validated 1000-120000) via `AbortController`, and the timeout covers the **entire** operation — request, response headers, AND response body consumption (`.text()`/`.arrayBuffer()`), not just the initial `fetch()` resolving. A server that sends headers and then stalls the body is caught the same way a server that never responds at all is; the timer is only cleared once the whole operation, body included, has settled. A network/storage outage therefore can't hold the request (and any DB transaction/row lock a caller holds alongside it, e.g. PDF finalization — see `docs/DECISIONS.md`) open indefinitely. A timeout raises a typed `StorageTimeoutError`, distinguishable from a plain HTTP/network failure. `SUPABASE_URL` and `SUPABASE_STORAGE_BUCKET` are validated at provider construction in every environment, not just production: a valid URL, and a bucket name that is a plain, unambiguous identifier — no path separators, and the exact dot-segment values `.`/`..` explicitly rejected (per RFC 3986, those two specific values are special in a URL path even though every character in them is individually "safe").
- PDF finalization additionally cleans up a newly uploaded object if the enclosing database transaction fails anywhere after the upload succeeded — including at `COMMIT` itself, which runs after the transaction's own callback has already returned successfully (see `docs/DECISIONS.md`). Only an object uploaded by that specific attempt is ever deleted; an already-committed, already-referenced PDF is never touched.

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
- **Capability-driven recipient resolution** (`src/shared/notifications/recipient-resolver.js#resolveEligibleRecipients`, introduced for Procurement & Material Receiving V1 Checkpoint 3): a reusable, non-Gate-Pass-specific resolver that answers "which active users are actually eligible to perform this workflow action right now?" by reusing `getUserProfileById`/`isProfileActive` — the same single authoritative effective-permissions computation `authenticate.js` and the governance endpoints already share — rather than a second, hand-written reverse-direction SQL query that could silently diverge from it. Eligibility folds in role grants, individual GRANT/DENY overrides, active user/role/site state, and a site-or-broader-scope check, then enqueues one `recipient_user_id` row per eligible user with a recipient-specific idempotency key — never a single `recipient_role` row standing in for an unknown set of people. Deliberately O(active users) (one profile lookup per user) rather than a single clever query — correct-by-construction over cleverness, and cheap enough at this application's real scale.

---

## 12. Initial Admin / CEO Provisioning

There is no self-registration endpoint and no default/hardcoded admin or CEO account shipped with the system — a fresh database has zero users.

### 12.1 CEO

`scripts/create-ceo-user.js` (`npm run user:create-ceo`) creates a CEO
account the same way `create-admin-user.js` creates the first ADMIN — same
terminal-only bootstrap, same secure input handling (both now share
`scripts/lib/bootstrap-user.js`). Env vars are `CEO_EMAIL`, `CEO_FULL_NAME`,
`CEO_PASSWORD` (or piped via stdin, preferred — same procedure as §12.2 with
`CEO_` in place of `ADMIN_`), and `CEO_SITE_CODE` (default `MAIN`).

There is no API path that creates a CEO account — `CEO` is excluded entirely
from the assignable-role enum in `src/modules/users/users.validation.js`, so
a request naming it as a target role is rejected at input validation before
any service logic runs (see §6.1). The schema deliberately does not enforce
a singleton CEO: running the script again with a different email while a CEO
already exists succeeds and prints an explicit "N active CEO account(s)
already exist" note rather than silently creating a redundant one with no
visible trace. Running it again with the **same** email is still rejected,
identically to the admin script.

### 12.2 ADMIN

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

### 12.3 Every Other Role

Every account other than the first ADMIN and CEO is now created through the
governance API (`src/modules/users/`, §6.1) rather than a terminal script —
`POST /api/v1/users`, permission-gated (`users.create`, plus `users.create_um`
for the Upper Management role specifically), never a public/self-service
endpoint. `CEO` itself remains excluded from that API entirely (§12.1).

An ordinary `EMPLOYEE` login is a further-narrowed case of this: HR
provisions it through `POST /api/v1/employees/:id/login`
(`src/modules/employees/employees.service.js`'s `createLoginForEmployee`),
which never accepts a role parameter from the caller at all — the inserted
role is always `EMPLOYEE` in the SQL itself, so no permission mistake or
payload manipulation can produce a privileged account through that path.
It sets `must_change_password = true` and returns a one-time temporary
credential in the response body only — never logged, never retrievable
again. `POST /api/v1/employees/:id/login/reset` (`employees.account.reset`)
issues a fresh one-time credential the same way and additionally bumps
`session_version`, immediately invalidating whatever session the prior
credential may still have had open (§5.1) — the one place in this codebase
a credential-adjacent action deliberately does force that, since the goal
is explicitly to kill the old credential's access, not merely gate the next
privileged action.

---

## 13. Workforce Authorization Model

The migration-owned defaults are deliberately conservative and are the
only role-level defaults: CEO receives all 41 Workforce permissions plus
all nine governance permissions; HR receives 26 operational permissions
(Employee CRUD/status/assignment/onboarding/import, visible documents and
bulk export, configuration, reports/export, rotation, leave approval, and
self profile); Upper Management receives only seven read/decision
permissions (`employees.view`, report view, rotation view, leave approval,
document metadata view, and self profile view/edit); Employee receives only
the four self-service permissions (profile view/edit and leave create/view).
Identity-bound self routes additionally provide the documented own-record
surface (for example finalized contracts and own compensation) without
granting any cross-employee permission.
Contract and compensation administration/export, cross-site scope, and
business-history removal are not HR or UM defaults. Existing Gate Pass roles
receive zero Workforce permissions. Per-user GRANT/DENY can change these
effective sets, with DENY always winning as described in §6.1.

- **Self record ownership is identity-based; profile capabilities are still permission-based.**
  `src/modules/workforce/workforce.authorization.js`'s `isSelf`/
  `assertEmployeeViewable` compare the authenticated request's own
  `req.user.employeeId` (resolved server-side from `employees.user_id` via
  the same `getUserProfileById` query `authenticate.js` already runs on
  every request — never a client-supplied id) against the record being
  accessed. An `EMPLOYEE` role holding zero `employees.*` permissions still
  reaches their own basic Employee record through this path; profile read
  and edit additionally require the effective `profile.self.view` and
  `profile.self.edit` permissions, so an individual CEO `DENY` takes effect
  on the next request. Every other actor needs the
  specific permission plus site scope. Every Workforce sub-resource
  (profile, documents, compensation, contracts, rotation, leave, history)
  reuses this same check via `employees.service.js`'s `getEmployee` rather
  than re-deriving it.
- **`mustChangePassword` is enforced twice, deliberately.**
  `requirePermission` (§6) rejects any permission-gated request from such a
  user; `requirePasswordChanged` (`src/shared/authorization/require-password-
  changed.js`), applied via `router.use` on every Workforce router, covers
  the self-service routes that have no permission check to hook into (e.g.
  `/me/profile`). Neither ever affects a pre-existing Gate Pass account —
  the flag defaults `false` and only Workforce onboarding/reset ever set it
  `true`.
- **Compensation**: self-viewable with no special permission (an employee
  seeing their own salary is ordinary, not a confidentiality concern);
  every other viewer needs `compensation.view`/`compensation.history`. No
  actor — including CEO — may record their own compensation change
  (`compensation.service.js`); attempting to is rejected before any query
  runs. Compensation records are insert-only both in the service and by a
  DB `BEFORE UPDATE OR DELETE` trigger. The amount is never written into
  `employee_business_history` or `governance_audit_log` metadata, and a
  report/export never fetches compensation at all (not just hides it)
  unless the requester holds `compensation.export` — see
  `test/workforce-reports.test.js`.
- **Contracts** are the one record type immutable even against CEO — see
  §8.2's description of `employee_contracts_enforce_immutability` and the
  finalized-delete trigger. Contract permissions
  (`contract.view/create/edit_draft/finalize/download/amend`) are granted
  to nobody by default except CEO; delegating one (e.g. `contract.create`
  to HR) does not imply the others — proven in
  `test/workforce-compensation-contracts.test.js`. An employee's self
  access to contracts is view/download-only and excludes `DRAFT` entirely
  (nothing has been agreed yet).
- **Excel exports** go through `src/shared/reports/excel-safety.js`'s
  `sanitizeCell` (OWASP formula-injection mitigation: a string cell
  starting with `=`, `+`, `-`, `@`, tab, or CR is quote-prefixed before
  being written) and `safeExportFilename` (server-generated, never
  user-input-derived). Every export is logged to `governance_audit_log`
  (`WORKFORCE_EXPORT_GENERATED`) with a record count and scope summary,
  never the underlying sensitive values.
- **XLSX import** accepts the exact server template only, rejects formula
  cells, bounds compressed bytes, declared ZIP expansion, entries, sheets,
  and rows, validates every reference and duplicate before mutation, and
  requires a short-lived HMAC confirmation bound to the actor and exact
  workbook. Confirm reparses/revalidates and writes all rows in one
  transaction. The import schema has no login, role, salary, compensation,
  contract, or permission columns.
- **Bulk ZIP export** requires `employees.view`, `workforce.export`,
  `employee_documents.bulk_export`, and `employee_documents.download`, then
  applies site and file visibility again. Contracts require their separate
  view/download permissions. It caps employees/files/declared bytes,
  streams the archive, verifies each checksum, and uses only generated path
  components; original client filenames never become ZIP paths.
- **Custom fields cannot bypass a protected concept.** Reserved field-key
  concepts (`salary`, `compensation`, `pay`, `payroll`, `wage`, `contract`,
  `password`, `role`, `permission`, `ceo`, `token`, `session`, `cnic`) are
  rejected in both the field key and human label at
  validation (`src/modules/workforce-config/workforce-config.validation.js`).
  This is defense in depth — the real guarantee is structural: custom-field
  values live in their own table with no code path into salary, contract,
  or permission logic at all.

---

## 14. Audit / Log Management Authority — Platform Invariant

This is a platform-wide invariant, binding on every module's audit/history
infrastructure (existing and future — Gate Pass's `gate_pass_audit_log`,
Workforce's `governance_audit_log`/business-history removal, and any later
Procurement/Receiving audit log per `docs/PROCUREMENT_RECEIVING_SPEC.md`
§37), not specific to any one module:

- **Ordinary users cannot modify or delete historical logs.** Every audit
  table is append-only at the application layer (no `UPDATE`/`DELETE`
  route exists for one), and the existing `forbid_update_delete()`
  DB trigger (reused, not reinvented, by every audit table added so far)
  makes this a structural guarantee, not merely an application convention.
- **Holding Upper Management does not automatically grant log-management
  authority.** This mirrors the same "action authority is separate from
  scope authority" principle already established for `users.create_um`/
  `users.manage_um` (§6.1: "holding UPPER_MANAGEMENT itself never implies
  it") and reaffirmed for `material_catalog.all_departments` (§1 of the
  Procurement & Material Receiving spec — UM's baseline in every module is
  the conservative, explicitly-enumerated set established in
  `docs/DECISIONS.md`'s Workforce entries, never a role-implied broad
  grant).
- **CEO holds exceptional log-management authority by default.** The
  existing precedent is `business_history.remove` — "CEO; delegable
  per-user" (`1787405000000_workforce-schema-foundation.js`) — CEO-only
  logical removal, requiring password re-confirmation, itself recorded in
  `governance_audit_log` as a forensic, protected event (§6.1).
- **CEO may delegate a specific log-management capability to a specific
  Upper Management user** through the existing per-user GRANT/DENY
  override mechanism (`user_permission_overrides`) — never by changing a
  role's baseline, and never inherited by every UM member. Delegation is
  **revocable** the same way any other individual grant is (a later DENY,
  or removing the override).
- **Exceptional log actions remain traceable.** A CEO (or a delegated UM
  member) performing a log-management action is itself audited — the
  action is never invisible, matching the existing "a blocked
  privilege-escalation attempt is audited before the 403 is returned"
  posture (§6.1) applied to successful exceptional actions as well as
  blocked ones.
- **Prefer correction/reversal/history-preserving patterns over silent
  destructive rewriting** wherever the domain allows it — logical removal
  (flag + reason + timestamp, never a real `DELETE`) is the default shape;
  a genuine hard delete is reserved for cases the domain cannot express any
  other way, and remains structurally blocked by the audit trigger
  regardless of actor, including CEO and a direct SQL session (§8.2).
- **This invariant does not weaken any existing audit immutability or
  security protection.** It documents the intended authority model for
  *managing* logs (who may ever touch one, and how); it does not loosen
  §8.2's DB-level append-only guarantees, and no new log-management UI or
  endpoint is introduced merely by documenting this invariant — one is
  built only when a specific module's checkpoint actually requires it.


---

## 15. Procurement & Material Receiving V1 — Security Model

Checkpoints 6-8 add the IPO, purchasing, Delivery Challan, receiving,
documents and exports. They introduce no new authentication, authorization
or audit mechanism — every rule below is the existing platform model applied
to new records.

### 15.1 Financial confidentiality is a query-projection boundary

Commercial data (estimated price, actual purchase price, totals, internal
Procurement notes, previous-price history) is only ever SELECTed for an
actor holding `procurement.view_prices`, `procurement.purchase` or
`procurement.pricing`. A request without that authority does not receive
those columns and then hide them — the projection never contains them. This
holds identically in the API, the PDFs and the Excel exports, matching the
Workforce compensation precedent in §13.

Consequences that are enforced and tested:

- `ipo.view` is operational visibility only. A Team Lead can follow their
  department's IPO — quantities, statuses, delivery and receiving progress —
  and never see an amount.
- The **IPO PDF additionally requires commercial authority**, so an
  operational viewer cannot use the document endpoint as a price-leak
  bypass. ADMIN and Gate Guard are refused it.
- The **Demand List PDF carries no pricing for any viewer at all**, CEO
  included. One unpriced representation removes the possibility of that
  endpoint becoming a financial-authorization bypass.
- The **Delivery Challan has no price column in its schema**, so the
  operational document a department receives — including the copy shared
  over WhatsApp — cannot leak commercial information.
- Receiving screens and APIs contain no pricing at all: confirming physical
  arrival never requires a price.
- Audit metadata and notification payloads carry identifiers and quantities
  only, never prices or Procurement notes — both streams have a wider
  audience than the price capability.

`backend/test/procurement-security-sweep.test.js` sweeps every readable
surface with distinctive commercial values and asserts none of them escape
to a price-blind department user, to ADMIN, to HR or to the Gate Guard.

### 15.2 Action authority is separate from record scope

**Admin fallback custody is contextual authority, not a scope tier.**
`receiving.fallback_receive` is deliberately absent from the generic
supply-chain scope resolver. It authorizes one narrow physical act — taking
temporary custody of another department's delivery at the actor's own site
when nobody from that department is available — and reaches only the queue of
still-open deliveries at that site, the detail of such a delivery, and the
fallback receipt itself. It expires when the delivery closes. It never widens
access to IPO records, purchasing, receiving history, carry-forward sources,
Procurement exports or any commercial data, and it never crosses a site
boundary.

A fallback custodian's receipt list is their ordinary department history plus
the specific receipts they personally recorded or took handover of — never
another department's history. The personal part matters because an Admin
belongs to the Admin department: without it, the delivery they took custody of
would vanish from their own history the moment they recorded it, leaving them
unable to follow the handover they are responsible for. It is added to their
normal scope, never substituted for it, and it is actor-specific: a second
Admin in the same department sees nothing extra. Requesting a department
filter suppresses it, so a filter can only narrow a result.


One shared resolver (`shared/authorization/supply-chain-scope.js`) applies
the same three tiers Material Demand established — ALL (CEO /
`demand.all_departments`), SITE (a cross-department responsibility holder),
OWN (an ordinary department actor) — to IPO, Delivery Challan and Receiving
alike. Holding `receiving.receive` says the actor may record a receipt,
never whose material. An out-of-scope record id is reported identically to a
nonexistent one, so a caller cannot probe for another department's or site's
records.

The deliberate receiving split is a security control, not a convenience:
ordinary `receiving.receive` never crosses a department boundary, while
temporary Admin custody requires the separate, explicitly granted
`receiving.fallback_receive` (cross-department, still site-bound). ADMIN
holds the fallback capability and NOT the ordinary one.

`procurement.purchase`, `dc.manage` and `ipo.cancel` are CEO-only by
default; no PROCUREMENT global role was invented, and an individual DENY
always wins.

### 15.3 Documents

PDFs are generated server-side from persisted data, never from client-
supplied content, and are never served from a public or guessable path.
Authorization is re-checked on every download. A finalized IPO/DC has its
rendered bytes stored in `procurement_documents` (append-only) so an issued
document stays historically stable.

Business references legitimately contain `/` (`ESET/2026/32`). Every
download filename is derived through `documentFilename()`, which allowlists
`[A-Za-z0-9_-]` and excludes `.` from the base name — no input can produce a
path separator, a `..`, a second extension, or a quote/newline that would
break a `Content-Disposition` header.

### 15.4 Export authority never widens data authority

`procurement.export` means only "may take out what you can already see".
Every commercial column is gated again at projection level, and the
inherently commercial `procurement-history` dataset is refused outright
without price authority rather than served empty. Filters are applied
server-side in SQL over a scoped query. Formula injection is neutralized
with the existing `sanitizeCell` while numeric/date cells keep their real
types. Every export writes a `PROCUREMENT_EXPORT_GENERATED` governance audit
row recording the dataset, row count, whether pricing was included, and the
filters applied.

### 15.5 WhatsApp document delivery

Only the official WhatsApp Business Platform is supported. No WhatsApp Web
scraping, headless-browser automation, reverse-engineered session library or
personal-account session reuse exists in this codebase, and none will be
added. Credentials come only from the environment and never appear in
source, the database, logs, audit metadata or API responses; provider error
text is never persisted verbatim into a durable outbox row (ESDMS-021).

Delivery is an outbox job that runs after the business transaction has
already committed, so a messaging failure can never roll back, delete or
block an IPO or a Delivery Challan. Retries cannot double-send: the
idempotency key is stable per document, an in-flight external job whose
outcome is unknown goes to `UNCERTAIN` rather than being replayed, and a
document for a cancelled record is voided instead of shared. When delivery
is disabled or unconfigured the row is written terminally as `DISABLED`
with a reason — never left pending, never misreported as failed. Captions
carry the document reference only, never an amount.

### 15.6 Audit immutability (extends §14)

`procurement_audit_log` and `material_receipt_lines` are append-only at the
database level via the existing `forbid_update_delete()` trigger. Issued
IPOs, IPO lines, Delivery Challans, receipts and stored documents cannot be
deleted at all, and their identity/snapshot columns cannot be changed. No
Procurement or Receiving endpoint modifies or deletes history for any role,
Upper Management included — the §14 invariant is preserved, and no second
governance mechanism was introduced.

### 15.7 Financial corrections

A purchase is never edited or deleted. A mistake is withdrawn by a reversal
event that names the exact purchase it reverses and inherits that purchase's
price — the API accepts no price on a reversal, so a correction cannot be used
to restate value. Reversals cannot exceed the purchase they reverse (checked
under a row lock, so concurrent corrections serialize), cannot reference a
purchase on another IPO line (structurally, via a composite foreign key),
cannot reverse another reversal, and cannot reduce purchasing below what a
Delivery Challan already carries. A correction requires a reason and is
audited by the purchase it touched; recording one needs exactly the same
purchasing capability as recording a purchase — no new authority exists.

Purchase history remains financial data: it is projected only for an actor
with price authority, along with the reversal linkage itself.

### 15.8 Request idempotency

Receiving, Delivery Challan creation and purchasing each require a
client-generated `operation_id`, unique at the database level. A retry after a
lost response returns the record that already exists rather than booking a
second physical receipt, cutting a second challan (consuming a second DC
number), or recording a second purchase — and writes no second audit event,
because nothing happened. A genuinely separate operation carries a new id.
This matters most on a phone at a site gate, where a lost response is routine.

An operation id identifies one logical request **against one parent**, and that
binding is enforced. For Delivery Challan creation, an id already owned by a
challan on a different IPO is rejected as a conflict rather than answered with
that challan: returning it would report a shipment as cut that never was, and
would report it with a success status. A purchase-event operation id likewise
identifies one semantic purchase operation: reuse with another IPO, another
line, a different quantity or price, a different event type (purchase versus
correction) or a different reversal source is rejected, because returning
success would report a purchase that never happened. A receiving operation id
identifies one semantic receipt operation in the same way: the same Delivery
Challan with the same receipt payload replays to the same receipt, while reuse
against a different challan — or with a materially different payload — is
rejected. The payload compared is the physical fact recorded: the custody type
(an ordinary department receipt and temporary Site Administrator custody are different
facts), the physical receiver, the exact set of Delivery Challan lines, and each
line's received quantity, discrepancy quantity and discrepancy type. Free-text
wording is deliberately excluded — a reworded note changes nothing about what
quantity or custody was booked, so it must not break a legitimate retry.

The conflict names nothing about the owning request, so a guessed id reveals only that it is in use — which global
uniqueness makes unavoidable — never which IPO, department or site owns it.
Ordinary authorization still applies first: an operation id is never a
capability or scope bypass.

### 15.9 Concurrency

One documented lock order covers the whole chain: **Demand → Pricing → IPO →
Delivery Challan → Material Receipt.** Every writer takes the subset it
needs in that order and re-validates state only after acquiring the locks;
unlocked reads exist solely to discover which parent rows to lock. Database
constraints back every service-level rule that matters — exactly-once IPO
generation (`unique (demand_id, demand_revision)`), no double allocation of
purchased quantity to Delivery Challans, no over-receipt against a Delivery
Challan line, and frozen line dispositions once a final decision exists — so
none of them depends on service code alone.
