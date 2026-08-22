# E-Set Digital Management System
## Architectural Decisions

This document records important technical and architectural decisions.

Do not rewrite old decisions when a later decision changes them.

Instead, add a new dated entry explaining what changed and why.

---

## 2026-08-21 — Use PostgreSQL

### Decision

Use PostgreSQL as the primary application database.

### Reason

The system requires relational workflows, transactions, constraints, auditability, modular business data and strong data integrity.

### Status

Accepted.

---

## 2026-08-21 — Use React + Vite for Frontend

### Decision

Use React with Vite for the frontend.

The frontend is intended to become a Progressive Web App.

### Reason

This matches the approved project architecture and supports a modular, responsive web application.

### Status

Accepted.

---

## 2026-08-21 — Use Node.js + Express for Backend

### Decision

Use Node.js and Express for the backend REST API.

### Reason

The backend will act as the trusted application layer for authentication, authorization, validation, business logic, database access and audit-sensitive operations.

### Status

Accepted.

---

## 2026-08-21 — Use Versioned REST APIs

### Decision

Use `/api/v1` as the initial API base.

### Reason

Versioned routes provide a clear path for future compatibility without introducing unnecessary complexity now.

### Status

Accepted.

---

## 2026-08-21 — Frontend Is an Untrusted Client

### Decision

Treat the browser/frontend as an untrusted client.

Security-sensitive decisions must be verified on the backend.

### Reason

Frontend code and requests can be inspected, modified, replayed or manually generated.

Frontend visibility rules therefore cannot provide authoritative security.

### Status

Accepted.

---

## 2026-08-21 — Gate Pass Is the First Business Module

### Decision

Develop Gate Pass before Inventory and other major business modules.

### Reason

The platform foundation and first module must be stabilized before introducing additional business complexity.

### Status

Accepted.

---

## 2026-08-21 — Inventory Must Not Begin Before Gate Pass Stabilization

### Decision

Do not begin Inventory implementation until Gate Pass MVP is stable and required regression/security review has been completed.

### Reason

This protects module independence and reduces the risk that future Inventory work breaks Gate Pass.

### Status

Accepted.

---

## 2026-08-21 — Keep Gate Pass and Delivery Challan Separate

### Decision

Gate Pass and Delivery Challan remain separate records and separate operational workflows.

### Reason

Gate Pass manages vehicle/driver movement.

Delivery Challan and material verification belong to procurement/inventory-related workflows.

### Status

Accepted.

---

## 2026-08-21 — Guard Role Remains Gate-Focused

### Decision

The Gate Guard does not perform inventory item verification and must not receive unrelated procurement/inventory access.

### Reason

The gate workflow should remain fast, focused and aligned with operational responsibilities.

### Status

Accepted.

---

## 2026-08-21 — Backend Controls Gate Pass State Transitions

### Decision

Sensitive Gate Pass state transitions are explicit backend operations.

The frontend must not arbitrarily assign authoritative Gate Pass statuses.

### Reason

Workflow state is security-sensitive business data and must be validated against current state, actor permissions and business rules.

### Status

Accepted.

---

## 2026-08-21 — Use Git Checkpoints Throughout Development

### Decision

Develop in small phases and create clean Git checkpoints after verified milestones.

### Reason

This provides a known-good recovery point when AI-generated or manual changes introduce regressions.

### Status

Accepted.

---

## 2026-08-21 — Repository Is the Technical Source of Truth

### Decision

Current repository code, migrations, configuration and documentation take precedence over remembered implementation details from old conversations.

### Reason

Long-running AI-assisted projects can suffer from stale context.

Keeping authoritative project truth inside the repository reduces accidental mixing of old and current implementations.

### Status

Accepted.

---

## 2026-08-22 — Gate Pass Spec Adopted; Scope Raised to Demo-Ready Product

### Decision

`docs/GATE_PASS_SPEC.md` is now the authoritative Gate Pass business spec
(previously empty). Target raised from a minimal MVP to a polished,
demo-ready product on production-intended architecture, per explicit
instruction. Roles are `TEAM_LEAD`, `ADMIN`, `SITE_MANAGER`, `GATE_GUARD`;
Driver has no login account.

### Status

Accepted.

---

## 2026-08-22 — "Team" Scope Defaults to Department

### Decision

Team Lead's "own/team" Gate Pass visibility is implemented as "same
`department_id`". There is no team/hierarchy table.

### Reason

No team-membership model exists yet and none was specified. Department is
the closest existing concept and keeps the authorization rule isolated to
one function, so a real team table can replace it later without touching
service/workflow code.

### Status

Accepted as a temporary default — revisit if a real team hierarchy is
required.

---

## 2026-08-22 — Gate Pass Number Format

### Decision

Gate Pass numbers are server-generated, sequential per calendar year:
`ESD-YYYY-NNNNNN` (e.g. `ESD-2026-000001`).

### Reason

No specific numbering scheme was mandated. This is human-readable, sortable,
collision-free via a DB sequence, and matches the "authoritative Gate Pass
Number" requirement.

### Status

Accepted — easy to change format without a schema redesign (number stays a
plain unique text column).

---

## 2026-08-22 — JWT Bearer Auth Kept; Storage Strategy Hardened, Not Replaced

### Decision

`docs/SECURITY.md` recommends httpOnly cookie sessions; the existing,
working implementation uses `Authorization: Bearer` JWTs. The working
implementation is kept rather than replaced, per "do not casually replace
working architecture." Hardening applied instead: short expiry (8h, already
set), token held in memory/React state (not `localStorage`) with
`sessionStorage` used only for surviving a page reload within the same tab,
required-secret validation at startup, and a login rate limiter.

### Reason

Switching to cookie-based sessions is a bigger architectural change
(CSRF handling, cookie domain/SameSite config, PWA-service-worker
interaction) than justified tonight, and the existing Bearer scheme is
functional and already reviewed once. `localStorage` is avoided specifically
because it is readable by any injected script for the life of the token.

### Status

Accepted for this phase — flagged as a candidate for revisit if offline PWA
sync requires longer-lived credentials later.

---

## 2026-08-22 — Local Disk Storage & Demo WhatsApp Provider Behind Interfaces

### Decision

`StorageService` and `WhatsAppProvider` are implemented as interfaces with
a local-disk storage provider and a demo/simulated WhatsApp provider,
because no cloud storage or Meta WhatsApp Business API credentials were
supplied.

### Reason

Explicitly directed: business code must not depend on the concrete
provider; demo providers must clearly mark output as simulated, never fake
real delivery/success.

### Status

Accepted. Swapping in real providers later is a configuration + adapter
change, not a business-logic change.

---

## 2026-08-22 — Placeholder Department Reference Data

### Decision

Seeded six department names (Electrical, Mechanical, Civil, HSE, Warehouse,
Administration) in the `gate-pass-schema` migration so the demo has working
dropdown data end-to-end.

### Reason

`gate_passes.issuing_department_id` is NOT NULL and no real department list
exists yet (0 rows before this migration). No department-management UI/API
is in scope this phase, so without seed data Gate Pass creation would be
blocked entirely.

### Status

Accepted as placeholder — replace via a real migration once management
supplies the actual department list. Renaming/adding departments is a data
change, not a schema change.

---

## 2026-08-22 — First-Class Site Model Added

### Decision

Added a `sites` table and `site_id` on `users`, `departments`, and
`gate_passes` (nullable-then-backfilled-then-`NOT NULL`, via migration).
`isWithinGatePassScope` now checks site first, absolutely — no role grants
cross-site access. Department name uniqueness became `(site_id, name)`
instead of a global unique name.

### Reason

An independent security review found the schema and authorization layer had
no multi-site concept at all, while the org is genuinely multi-site — every
department/Gate Pass query was implicitly single-tenant. Retrofitting now,
before Inventory or other modules build on the same gap, is cheaper than
migrating live data later.

### Status

Accepted. All Gate Pass reads/writes, department master data, guard search,
QR verification, and file access are site-scoped.

---

## 2026-08-22 — Switched Browser Auth From Bearer/sessionStorage to HttpOnly Cookie

### Decision

Supersedes the 2026-08-22 "JWT Bearer Auth Kept" entry above (left
unmodified per this document's own rule). The frontend no longer stores a
token in `sessionStorage` or attaches `Authorization: Bearer` itself; the
backend sets an `HttpOnly`, `SameSite=Lax`, `Secure`-in-production session
cookie on login (`src/shared/http/session-cookie.js`), and all frontend
`fetch` calls use `credentials: "include"`. `Authorization: Bearer` support
is kept server-side for non-browser clients (scripts, this project's own
test suite).

### Reason

An independent security review flagged `sessionStorage` as readable by any
injected script for the life of the token — a real XSS in any dependency
would be a full session-token exfiltration, which an `HttpOnly` cookie
structurally prevents. `SameSite=Lax` on a JSON-only API (no HTML
form/simple cross-site request can trigger a state-changing call with the
cookie attached) covers CSRF without needing a separate token.

### Status

Accepted.

---

## 2026-08-22 — Approval PDF Generation Moved to a Durable Outbox Job

### Decision

`POST /gate-passes/:id/approve` no longer generates the PDF and enqueues
the WhatsApp delivery inline, after the approval transaction commits. It
enqueues a `SYSTEM` / `GENERATE_APPROVAL_PDF` outbox job in the *same*
transaction as the approval itself. A background worker (extending the
existing outbox poller) claims and processes that job — idempotently: it
re-derives "already done?" from whether an `APPROVED_PDF` file row already
exists, rather than trusting its own prior attempts, so a retry after a
partial failure is always safe. The outbox itself gained atomic claiming
(`FOR UPDATE SKIP LOCKED`, a `PROCESSING` status with a `locked_at` lease so
a crashed worker's claim eventually times out and becomes reclaimable) and
an `idempotency_key` column (`ON CONFLICT DO NOTHING`) so a job's own
retry can't double-enqueue its follow-up job.

### Reason

An independent security review found that if PDF generation or its storage
write failed after the approval status change had already committed, the
HTTP response to the approver was a misleading `500` (the approval had, in
fact, already succeeded) — encouraging a confusing retry against an
already-approved record. Making the job itself as durable as the approval
(same transaction) means approving a Gate Pass can no longer fail because
of downstream PDF/WhatsApp trouble, and a crashed process before the worker
runs never silently drops the PDF.

### Status

Accepted.

---

## 2026-08-22 — Database Privilege Boundary and Verified TLS for Production

### Decision

Two separate Postgres credentials: `MIGRATION_DATABASE_URL` (schema-owner
role, used only by `node-pg-migrate`) and `DATABASE_URL` (the runtime role
the API process actually connects as, granted only `SELECT`/`INSERT`/
`UPDATE`/`DELETE` on application tables — no `SUPERUSER`/`CREATEDB`/
`CREATEROLE`, no DDL). `scripts/provision-db-roles.sql` contains the exact
grants to set this up once per environment. In production
(`NODE_ENV=production`), the runtime Postgres pool requires TLS with
certificate verification (`ssl: { rejectUnauthorized: true }`), not just an
encrypted-but-unverified connection.

### Reason

An independent security review flagged that the application had no
privilege boundary — a compromised app process (e.g. via a future SQL
injection bug) would otherwise be able to alter schema or create roles, not
just read/write data — and no verified transport encryption was configured
for a production Postgres connection (e.g. Supabase).

### Status

Accepted. `scripts/provision-db-roles.sql` must be run against the target
Postgres instance, as the owner role, before pointing production
`DATABASE_URL` at the restricted runtime role — not yet run against any
real deployment, since deployment itself is out of scope until independent
re-review of this fix pass is complete.

---

## 2026-08-22 — Second Review Pass: Deployment Readiness and Defense-in-Depth

### Decision

A second, independent security/architecture review examined the codebase
after the first fix pass. The entries below record its notable decisions.
Superseded/extended prior entries are left unmodified per this document's
own rule; see each entry for what it changes.

### Status

Accepted.

---

## 2026-08-22 — Configurable HOST Binding for PaaS Deployment

### Decision

The backend now binds to a configurable `HOST` (`src/config/env.js`,
`src/server.js`), defaulting to `127.0.0.1` in development and `0.0.0.0` in
production, instead of a hardcoded `127.0.0.1`.

### Reason

Render (and most PaaS platforms) route public traffic to the container over
its internal network; a server bound only to `127.0.0.1` is unreachable from
outside the container, which would have made a Render deploy silently fail
to receive traffic.

### Status

Accepted.

---

## 2026-08-22 — Storage Provider Selected by Configuration; Production Requires Durable Storage

### Decision

`StorageService` now selects its concrete provider from `STORAGE_PROVIDER`
(`local` or `supabase`) instead of always using the local-disk provider.
`SupabaseStorageProvider` talks to Supabase Storage's REST API via plain
`fetch()` (no new SDK dependency). Production configuration validation
refuses to start with `STORAGE_PROVIDER=local` unless explicitly overridden
to `local-single-instance-accepted-risk`. Supabase credentials are variable
names only in `.env.example`; no real Supabase project has been connected.

### Reason

The local-disk provider was previously used unconditionally, including in
what would become a production build — on a redeploy or a multi-instance
PaaS deployment, on-disk evidence photos and generated PDFs would silently
disappear. Config-driven selection lets local disk remain the correct choice
for development/tests while making production storage an explicit,
fail-fast decision rather than an accident.

### Status

Accepted. Real Supabase connection remains out of scope until deployment is
authorized.

---

## 2026-08-22 — Notifications Scoped by Site, Not Just Role

### Decision

`notification_outbox` gained a `recipient_site_id` column, derived
authoritatively from the Gate Pass at enqueue time (never trusted from a
frontend filter). In-app notification listing requires either an exact
`recipient_user_id` match or a `(recipient_role, recipient_site_id)` match.

### Reason

A Guard notification addressed only by `recipientRole=GATE_GUARD` was
effectively visible to every Guard at every site — the first review pass's
site model (departments, Gate Passes, users) was never extended to the
notification outbox. This closes that gap consistently with the existing
site-scoping rule everywhere else.

### Status

Accepted.

---

## 2026-08-22 — Outbox Worker: Stale-Lease Reclamation and Entity-Recheck Registry

### Decision

`claimBatch` now reclaims `PROCESSING` rows whose lease (`locked_at`) has
expired, in addition to `PENDING`/`FAILED` rows, via the same
`FOR UPDATE SKIP LOCKED` claim query — a worker that crashes mid-job no
longer leaves that job stuck forever. A generic entity-recheck registry
(`registerEntityRecheckHandler` in `outbox.processor.js`, mirroring the
existing system-job-handler registry) lets any channel (SYSTEM, WHATSAPP)
re-verify its underlying entity is still in a deliverable state immediately
before acting, independent of the specific job type. The Gate Pass module
registers a recheck that voids the job if the pass has been cancelled.
Cancellation also voids any still-`PENDING`/`FAILED` job directly, in the
same transaction as the cancellation itself — the recheck registry is a
second, independent layer for the job already claimed by a worker when
cancellation happens. WhatsApp sends now carry the job's `idempotency_key`
through to the provider call.

### Reason

Two related gaps: (1) a worker crash left `PROCESSING` rows permanently
stuck, since the original claim query only ever looked at `PENDING`/
`FAILED`; (2) approving then immediately cancelling a Gate Pass before the
worker ran could still result in a PDF being generated and a WhatsApp
message being sent for a pass that was, by the time of delivery, cancelled.
A single voidPending() call at cancellation time isn't sufficient on its
own, since a job may already be claimed (`PROCESSING`) by a worker when
cancellation happens — hence the second, generic re-check layer.

### Status

Accepted.

---

## 2026-08-22 — Login No Longer Returns the JWT in the JSON Body

### Decision

`POST /auth/login` returns the user/profile in its JSON response but no
longer includes the raw JWT as a field — the token exists only in the
`HttpOnly` session cookie already set by the same response. Existing tests
were updated to assert the token field's absence rather than preserving it
for compatibility.

### Reason

The prior fix pass moved browser authentication to an `HttpOnly` cookie
specifically so an XSS in any dependency couldn't exfiltrate the session
token — but the login response still handed the same token back in
inspectable JSON, undermining that protection for any code path that read
the response body.

### Status

Accepted.

---

## 2026-08-22 — Session Revocation via `session_version`

### Decision

Added a `session_version` integer column on `users`, embedded in the JWT as
an `sv` claim at login and compared against the live database value on
every authenticated request. Logout increments `session_version`, which
immediately invalidates every outstanding token for that user.

### Reason

Previously, clearing the session cookie on logout did nothing to the JWT
itself — a copy of the token (e.g. captured before logout) would remain
valid until its 8-hour expiry regardless of logout. Of the two options
usually used for this (a sessions/JTI table for per-device revocation, or a
single version counter for coarse user-wide revocation), the counter was
chosen as the simpler mechanism; the coarser "logout ends every session for
that user" trade-off is reasonable here and arguably desirable for a shared
Guard kiosk device.

### Status

Accepted. Per-device revocation can be added later as a sessions table
without changing the JWT's shape if ever required.

---

## 2026-08-22 — Guard Direct-ID Fetch Discloses Only Actionable States

### Decision

`GET /guard/:id` (used for refresh/deep-link access) now only returns a
Gate Pass when it is same-site **and** in `APPROVED` or `VEHICLE_OUTSIDE`
state; every other state or a cross-site id returns not-found rather than
the record.

### Reason

The endpoint previously returned any same-site Gate Pass by id regardless
of its state — a Guard could look up a `DRAFT`, `PENDING_APPROVAL`,
`REJECTED`, or `CANCELLED` pass's details, which is more disclosure than
the Guard role's data-minimization principle (`docs/GATE_PASS_SPEC.md` §1)
allows, even though no Guard action was actually available on those states.

### Status

Accepted.

---

## 2026-08-22 — Guard Navigation Always Refetches Authoritative State

### Decision

Guard action pages (`GuardActionPage.jsx`) always refetch the Gate Pass on
mount/id-change instead of trusting React Router `location.state` to enable
EXIT/RETURN actions. Nav state is used only to render a nicer loading
message while the authoritative fetch is in flight.

### Reason

Using nav state to skip the initial fetch meant a Guard who navigated from
a list/search screen could see EXIT/RETURN enabled based on state that was
already stale by the time they acted — e.g. another Guard had already
recorded the exit in the interim — risking a wasted evidence-photo upload
against a transition the backend would then reject anyway. The backend was
always the final authority; this fixes the frontend to match on first
render, not just on retry-after-rejection.

### Status

Accepted.

---

## 2026-08-22 — Production Configuration Validated Fail-Fast at Startup

### Decision

`validateProductionConfig()` (`src/config/env.js`) runs once at module load
when `NODE_ENV=production`, checking `FRONTEND_ORIGIN`/`APP_PUBLIC_URL` are
`https://`, `STORAGE_PROVIDER` isn't the unacknowledged local default,
required Supabase variables are present when `STORAGE_PROVIDER=supabase`,
and `TRUST_PROXY_HOPS` is set explicitly (no default in production) — never
`app.set("trust proxy", true)` blindly, since that would trust every
`X-Forwarded-*` header from an arbitrary client sitting in front of a
misconfigured proxy count. All violations are collected into a single
thrown error rather than failing on the first one found.

### Reason

A production deploy with a misconfigured environment variable should fail
loudly at startup, not silently run with a weaker security posture (HTTP
QR links, non-durable storage, a trust-proxy setting that lets a client
spoof its own IP for rate limiting).

### Status

Accepted.

---

## 2026-08-22 — Database Relational Coherence Enforced by Composite Foreign Keys

### Decision

Added composite `UNIQUE`/`FOREIGN KEY` constraints instead of triggers:
a user's `department_id` must belong to the user's own `site_id`; a Gate
Pass's `issuing_department_id` must belong to the Gate Pass's own
`site_id`; `departure_photo_file_id`/`return_photo_file_id` must reference
a `gate_pass_files` row that actually belongs to that Gate Pass (evidence
files can't be swapped between passes); `gate_pass_items` is unique per
`(gate_pass_id, line_no)`; `gate_pass_files` is unique per
`(gate_pass_id, file_type, version)`.

### Reason

Application-level checks alone can't guarantee these invariants against a
future code path that forgets to enforce them (or a direct data fix). A
composite foreign key is enforced by Postgres itself, unconditionally,
which is both stronger and a smaller diff than a bespoke trigger for each
case — using magic per-table triggers was deliberately avoided in favor of
this narrower, standard mechanism.

### Status

Accepted.

---

## 2026-08-22 — Evidence Photo Validation Stays Signature-Based, Not a Decode/Re-encode Pipeline

### Decision

Evidence photo uploads continue to be validated against their real file
signature bytes (`src/modules/gate-pass/gate-pass.upload.js`) rather than
adding a full image-decoding/re-encoding library (e.g. `sharp`). The
remaining risk — a file whose magic bytes are genuine JPEG/PNG/WebP but
whose payload is crafted to exploit a bug in whatever downstream tool
eventually renders it — is accepted and documented rather than engineered
away this pass.

### Reason

The review (LOW severity) explicitly allowed documenting this risk instead
of building a decode/re-encode pipeline "if practical." A decode/re-encode
library adds a native-binary dependency that complicates the Render build,
for a threat that requires a rendering-side vulnerability to matter — these
files are private, authorization-gated, and viewed only by authenticated
staff through the app's own `<img>`/download flow, not embedded in any
public or XSS-prone context. Adding the dependency now is not justified by
the actual exposure.

### Status

Accepted as a documented residual LOW risk. Revisit if evidence photos are
ever exposed more broadly (e.g. public sharing, third-party rendering).

---

## 2026-08-22 — Deterministic Business Timezone for Numbering and Display

### Decision

Added `APP_TIMEZONE` (default `Asia/Karachi`) and a shared
`src/shared/time/app-timezone.js` helper. The Gate Pass number's year
(`nextGatePassNumber`) and the dates printed on the generated PDF are now
derived via `Intl.DateTimeFormat` pinned to `APP_TIMEZONE`, not the host
process's local timezone (`new Date().getFullYear()` previously). All
timestamps remain stored as UTC/`timestamptz` — only derivation/display
changed.

### Reason

A Render host may run in UTC or any other zone; a Gate Pass created near
midnight in the business's actual timezone must not be numbered into the
wrong year, and a printed document's dates must not silently shift
depending on which region happened to run the process that generated it.

### Status

Accepted.

---

## 2026-08-22 — PDF Item Table Rows Size to Their Tallest Wrapped Cell

### Decision

The Gate Pass PDF's items table (`src/modules/gate-pass/gate-pass.pdf.js`)
now measures each cell's wrapped height via `doc.heightOfString()` before
drawing, advances `doc.y` by the tallest cell in that row plus a fixed
gap, and inserts a page break when a row wouldn't fit before the bottom
margin. Previously every row advanced by a fixed `moveDown(0.6)`
regardless of how many lines a long description or part number actually
wrapped to, which let a wrapped cell overlap the next row.

### Reason

Real job-order descriptions and part numbers vary in length; a fixed row
height only worked by coincidence for short values.

### Status

Accepted.

---

## 2026-08-22 — Health Endpoint Split into Liveness and Readiness

### Decision

`GET /api/v1/health` stays a pure liveness check (process is up, no
dependency calls). Added `GET /api/v1/health/ready`, which runs `SELECT 1`
against the database and returns 503 (with no underlying error detail) if
that fails.

### Reason

A liveness check that also touches the database means a slow/degraded
database causes an orchestrator to kill and restart an otherwise-healthy
process — the two failure modes need to be distinguishable. Readiness
never leaks DB error text publicly.

### Status

Accepted.

---

## 2026-08-22 — First Admin User Provisioned via a Server-Side CLI Script, Not a Registration Endpoint

### Decision

Added `scripts/create-admin-user.js` (`npm run user:create-admin`), which
inserts a single `ADMIN` user directly via the database pool after
validating email/password/site with `zod` and hashing the password with
`argon2`. It supports a non-interactive mode (`ADMIN_EMAIL`,
`ADMIN_FULL_NAME`, `ADMIN_PASSWORD`, optional `ADMIN_SITE_CODE` env vars)
for scripted first-deploys and an interactive prompt fallback. There is no
browser-facing registration endpoint, and no default/seeded admin account
ships with the system — a fresh database has zero users until this script
is run.

### Reason

A public self-registration endpoint or a hardcoded default admin account
are both a standing attack surface (or, for a shared default credential,
an outright vulnerability) for a system with no other gate before the
first account exists. Requiring server-side execution (Render Shell / a
one-off job) means creating the first account requires the same access
level as deploying the system in the first place.

### Status

Accepted. There is currently no in-app UI/API for creating *additional*
users of any role beyond this first admin — every account is still
provisioned server-side. Tracked as a known gap for a real multi-user
rollout, not addressed this pass.

---

## 2026-08-22 — Require Same-Site Custom Domains for Production, Not SameSite=None

### Decision

`validateProductionConfig()` now requires a new `API_PUBLIC_URL` env var
(the backend's own public URL) and rejects startup if `FRONTEND_ORIGIN`
and `API_PUBLIC_URL` are not same-site — including the specific case of
two different subdomains under a shared multi-tenant PaaS host
(`onrender.com`, `vercel.app`, etc.), which a naive same-suffix check
would otherwise miss. The session cookie stays `HttpOnly` +
`SameSite=Lax` with no CSRF token, and `SameSite=None` remains
deliberately unimplemented as a configuration option.

### Reason

A default two-service Render deployment (separate `*-frontend.onrender.com`
/ `*-api.onrender.com` domains) starts successfully and looks fine —
`/health` answers, the frontend loads — but the browser never attaches the
session cookie to the cross-site request, so login silently fails to
persist. That failure mode is invisible until someone actually tries to
use the deployed app. Switching to `SameSite=None` to "fix" it would
remove the one mechanism currently standing in for CSRF protection
(`SameSite=Lax` already excludes the classic CSRF vector for this
cookie — see `docs/SECURITY.md` §5.2) without replacing it with anything.
Requiring same-site custom domains keeps the existing, already-reasoned-
about cookie design working unchanged, at the cost of one more required
production env var and a DNS step before go-live.

### Status

Accepted. No real company domain is hardcoded — both `FRONTEND_ORIGIN` and
`API_PUBLIC_URL` are environment-driven. `SameSite=None` + CSRF protection
remains a documented future option if a deployment genuinely cannot use
one registrable domain, but is not built.

---

## 2026-08-22 — A Crashed WhatsApp Send Goes UNCERTAIN, Never Auto-Resent

### Decision

`claimBatch` no longer reclaims a stale (lease-expired) `PROCESSING` row
for external-delivery channels (currently `WHATSAPP`). A separate sweep,
`reconcileStaleExternalDeliveries`, moves those rows straight to the
terminal `UNCERTAIN` status instead — never back to claimable. Internal
channels (`SYSTEM`) are unaffected and still reclaim normally.

### Reason

For an external delivery, a crash between "the provider accepted/sent the
message" and "our own `markDelivered()` write landed" is indistinguishable
from "the provider never got it," purely from local DB state. Reclaiming
and resending risks a real duplicate delivery — a driver actually
receiving the same WhatsApp document twice. `SYSTEM` jobs (PDF generation)
only ever write to storage/DB this application controls, so replaying the
same idempotent step on reclaim is safe and unchanged.

### Status

Accepted. `UNCERTAIN` is not automatically retried; resolving one requires
a human or provider-side lookup via the preserved `idempotency_key`. There
is currently no UI for that reconciliation step — tracked as future work
for whenever a real (non-simulated) WhatsApp provider is connected.

---

## 2026-08-22 — PDF Finalization Locks the Gate Pass Row for Its Full Duration

### Decision

`processApprovalPdfJob` now acquires the Gate Pass row lock
(`repo.lockDetailById`, `FOR UPDATE OF gp`) as its first step and holds it
through generate/upload/commit, re-checking `status !== CANCELLED` right
after acquiring it. Cancellation (`runTransition`'s cancel branch) already
locked the same row. Whichever transaction acquires the lock first now
fully determines the outcome.

### Reason

The existing defense layers (`voidPending` at cancel time, the generic
`stillDeliverable` re-check before a job handler runs) both read
authoritative state *before* finalization's own transaction begins —
leaving a window where cancellation could commit *during* finalization,
after its own check passed. A real row lock closes that window instead of
narrowing it, and as a side effect means a cancellation that wins the race
is detected before any PDF is generated or uploaded — nothing is left
orphaned in object storage to clean up after the fact.

### Status

Accepted.

---

## 2026-08-22 — Evidence Photo File-Type Coherence Enforced by Trigger

### Decision

Added a narrow `BEFORE INSERT OR UPDATE OF departure_photo_file_id,
return_photo_file_id` trigger on `gate_passes` verifying the referenced
`gate_pass_files` row has the matching `file_type` (`DEPARTURE_PHOTO` /
`RETURN_PHOTO` respectively). The existing composite FK only guaranteed
the file belongs to the same Gate Pass, not that it's the right kind.

### Reason

A composite FK can't express "must equal this literal value" — both sides
of a FK must be real columns, and `gate_passes` has no `file_type` column
of its own to pair against. A trigger scoped to exactly these two columns
(not a general-purpose/magic trigger) is the narrowest mechanism that can
express the actual invariant. The migration verifies no existing row
already violates it before installing the trigger, failing loudly rather
than silently enforcing only from that point forward.

### Status

Accepted.

---

## 2026-08-22 — Logout Distinguishes "Nothing to Revoke" from "Revocation Failed"

### Decision

`POST /auth/logout` now separates two previously-identical code paths: an
invalid/expired/missing token (nothing to revoke — succeeds, matching
logout's idempotent contract) versus a genuine database failure while
bumping `session_version` for a token that WAS valid (now a `503`, cookie
left in place). The frontend (`AuthContext.jsx`) only clears local session
state on a confirmed `200`, and shows an explicit failure message
otherwise (`TopBar.jsx`) instead of silently treating the request as
fire-and-forget.

### Reason

Reporting success when the revocation write actually failed would tell
both the user and the frontend that a session is dead when it is, in
fact, still live server-side — a false sense of security for exactly the
"I just logged out on a shared device" scenario this system's coarse,
user-wide revocation exists to serve.

### Status

Accepted.

---

## 2026-08-22 — Supabase Storage Calls Are Bounded by a Configurable Timeout

### Decision

`SupabaseStorageProvider` wraps every request (upload/download/delete) in
an `AbortController`-based timeout (`SUPABASE_STORAGE_TIMEOUT_MS`, default
10000ms, validated 1000-120000). A timeout raises a typed
`StorageTimeoutError` rather than an opaque `AbortError`. `SUPABASE_URL`
and `SUPABASE_STORAGE_BUCKET` are now validated at provider construction
time (valid URL; a plain bucket name with no path-traversal characters)
in every environment, not just production.

### Reason

PDF finalization holds a Gate Pass row lock for the duration of its
storage write (see the row-locking entry above) — an unbounded network
call to Supabase Storage would mean a storage-side outage could hold that
lock open indefinitely, blocking cancellation and anything else contending
for the same row.

### Status

Accepted.

---

## 2026-08-22 — Frontend Operational Timestamps Use a Centralized Business-Timezone Formatter

### Decision

Added `frontend/src/shared/utilities/datetime.js` (`formatDate`,
`formatDateTime`, `currentYear`), reading a new `VITE_APP_TIMEZONE` build
env var (default `Asia/Karachi`, matching the backend's `APP_TIMEZONE`
default). Every operational timestamp display (Gate Pass created/approved/
departure/return times, audit log entries, notification timestamps,
expected-return dates) now goes through this shared utility instead of
scattered `new Date(...).toLocaleString()` / `.toLocaleDateString()`
calls, which rendered in whichever timezone the viewer's own browser/OS
happened to be set to.

### Reason

A manager checking the dashboard while traveling, or any device with its
clock/region set incorrectly, must see the same operational times gate
staff see — the business's own timezone, not the viewer's. This mirrors
the backend's existing `APP_TIMEZONE` handling (PDF dates, gate pass
numbering) for the same reason. Backend timestamps remain stored as UTC/
timestamptz either way — only display is affected on both sides.

### Reason for a duplicated env var instead of fetching from the API

`VITE_APP_TIMEZONE` is build-time and non-sensitive; fetching it from the
backend would mean either blocking the first render on an extra request or
accepting a moment of wrong-timezone display before it resolves, for a
value that essentially never changes at runtime. The two are documented as
needing to match, in both `.env.example` files.

### Status

Accepted.

---

## 2026-08-22 — Frontend Test Storage Reset, Not an Undocumented NODE_OPTIONS Flag

### Decision

Added `frontend/vitest.setup.js`, registered via `test.setupFiles` in
`vitest.config.js`, clearing `localStorage`/`sessionStorage` before every
test. Also pinned `"engines": {"node": ">=20.0.0"}` in both `package.json`
files (validated against Node v24.19.0).

### Reason

`npm test` was reported to need `NODE_OPTIONS=--no-experimental-webstorage`
to pass reliably — undocumented flags aren't an acceptable standard test
command. The suspected mechanism is Node's own experimental global
`localStorage` (real, potentially disk-backed) interacting with jsdom's
per-environment storage in a way that could leak state across tests (e.g.
`NotificationBell`'s `lastViewedAt` key). This wasn't reliably reproducible
during this pass — plain `npm test` was clean across many runs both with
and without the flag — but resetting storage before every test is correct
test hygiene regardless of the exact root cause, and directly neutralizes
the specific failure mode described (leftover storage state affecting a
later test).

### Status

Accepted. `npm test` passes without any extra flags. If a real Node/jsdom
storage interaction is later confirmed as the definitive cause, this reset
already covers it; the `engines` pin documents the actually-validated
version.

---

## 2026-08-22 — PDF Metadata Column Reserves Space for the QR Code

### Decision

`generateGatePassPdf`'s header-block metadata rows (date, department,
requester, destination, driver, vehicle registration, expected return
date) are now drawn with an explicit `width: 250` clamp instead of
pdfkit's default (full remaining page width), and the content that
follows (the "Items" heading) starts at `Math.max(current y, QR block
bottom)` rather than wherever the metadata column happened to end. The
items table's column header row is now extracted into `drawTableHeader()`
and called again after every `addPage()`.

### Reason

A long destination/driver/department value previously wrapped at the
page's full width, which runs directly through the QR code's own printed
space. A short metadata column (few rows) could also leave the "Items"
heading starting inside the QR block's vertical footprint. Multi-page
Gate Passes (many line items) previously left the second and later pages
with no column headers, making the table ambiguous without flipping back
to page one.

### Status

Accepted.

---

## 2026-08-22 — NotificationBell Is a Disclosure, Not a Menu

### Decision

`NotificationBell`'s trigger button dropped `role="menu"`/`aria-haspopup
="menu"` in favor of a plain disclosure pattern: `aria-expanded` +
`aria-controls` pointing at the panel's id, and the panel itself is
`role="region"` containing a real `<ul>`/`<li>` list instead of
role-less `<div>`s. `MobileNav`'s trigger (in `TopBar.jsx`) gained the
same `aria-controls`/`aria-expanded` pairing against the drawer's now-
stable `id="mobile-nav-drawer"`.

### Reason

Notification entries aren't actionable commands (no click handler, no
keyboard activation) — `role="menu"` requires `role="menuitem"` children
with full arrow-key/Home/End roving-tabindex behavior to be correct, none
of which existed. A disclosure (button reveals a labeled region) is the
accurate, simpler pattern for informational content, per WAI-ARIA
Authoring Practices — not a compromise, the actual right widget for what
this is.

### Status

Accepted.

---

## 2026-08-22 — PWA Navigation Fallback Excludes /api/

### Decision

Added `navigateFallbackDenylist: [/^\/api\//]` to the Workbox config in
`vite.config.js`. Verified in the built `dist/sw.js` output: the
`NavigationRoute` now carries `{denylist:[/^\/api\//]}`.

### Reason

The SPA navigation fallback (serving `index.html` for any unmatched route
so client-side routing survives a hard refresh/deep link) previously had
no exclusion — a direct browser navigation to `/api/v1/...` could be
served the app shell HTML instead of reaching the real API. The existing
`NetworkOnly` runtime-caching rule for `/api/` already covered `fetch()`
calls the app itself makes; this closes the separate gap for actual
top-level navigation requests.

### Status

Accepted.

---

## 2026-08-22 — Admin Bootstrap Script Hardened: Active-State Checks, No-Echo Password, Stdin Path

### Decision

`scripts/create-admin-user.js` now rejects provisioning against a
deactivated site or a deactivated `ADMIN` role (previously it only
checked existence). The interactive password prompt suppresses terminal
echo via raw-mode stdin — no dependency added, correcting an earlier
attempt in this file that had accidentally embedded literal control-byte
characters instead of `\uXXXX` escape sequences. Non-interactive mode now
also accepts the password piped via stdin as an alternative to
`ADMIN_PASSWORD`, documented as the preferred production path since it
never appears in shell history or a `ps` listing.

### Reason

Provisioning the very first account into a deactivated site or role would
create an admin nobody could actually use to sign in (site/role active
checks already gate every login) — worth catching at creation time with a
clear message rather than a confusing later login failure. A password
visibly echoed to the terminal, or passed inline as an env var on a
command line, are both avoidable exposure for a credential this
sensitive; raw-mode stdin and a piped-password path close both without
adding a masking library.

### Status

Accepted.

---

## 2026-08-22 — Same-Site Validation Uses `tldts` (Real Public Suffix List), Not a Homemade Heuristic

### Decision

Replaced the hand-maintained "last two labels, with a hardcoded list of
known multi-tenant PaaS suffixes" heuristic in `registrableSite()`
(`src/config/env.js`) with [`tldts`](https://www.npmjs.com/package/tldts)'s
`getDomain(hostname, { allowPrivateDomains: true })`, computing the real
eTLD+1 against the Mozilla Public Suffix List. Added as a production
(runtime) dependency — it's needed at server startup, not just for
tooling/tests.

### Reason

The naive heuristic was actively wrong for multi-label public suffixes:
it would treat `app.customer-a.com.pk` and `api.customer-b.com.pk` — two
different customers' domains — as the same site, while getting
`app.company.com.pk` / `api.company.com.pk` (the same customer) right
only by the same wrong reasoning. `tldts` with `allowPrivateDomains: true`
also naturally covers the platform-suffix case (onrender.com, vercel.app,
etc. are PSL "private section" entries) without this codebase maintaining
its own list, which the previous heuristic did as a separate, parallel
mechanism.

### Status

Accepted. `npm audit` clean; `tldts` has no further runtime dependencies
of its own.

---

## 2026-08-22 — Supabase Storage Timeout Extended to Cover Full Response Body Consumption

### Decision

`SupabaseStorageProvider`'s `AbortController`-based timeout previously
cleared its timer as soon as `fetch()` itself resolved (response headers
received), before `.text()`/`.arrayBuffer()` had been called to consume
the body. Restructured so the same timer stays armed for the entire
operation — request, headers, AND body consumption — via a `#withTimeout`
helper that wraps the whole per-call async function, not just the
`fetch()` call inside it.

### Reason

A server that sends response headers and then stalls mid-body was
previously not covered by the timeout at all — exactly the failure mode
the timeout exists to prevent (an outage holding a DB row lock open
indefinitely during PDF finalization). Real `fetch`/undici ties an
in-flight body read to the same `AbortSignal` the request itself used, so
extending the timer's coverage was sufficient; no additional API surface
was needed.

### Status

Accepted.

---

## 2026-08-22 — Supabase Bucket Name Rejects Exact Dot-Segments

### Decision

`SupabaseStorageProvider`'s bucket name validation now explicitly rejects
the exact values `.` and `..`, in addition to the existing character-class
restriction (which already rejects `/`, spaces, and anything else outside
`[a-zA-Z0-9._-]`).

### Reason

Per RFC 3986 dot-segment removal, a URL path segment that IS exactly `.`
or `..` is special (normalized away, or walks up a directory) even though
every individual character in it is otherwise "safe" and passes the
existing character-class check. Nothing else needed tightening — ordinary
bucket names with dots/underscores/hyphens remain valid.

### Status

Accepted.

---

## 2026-08-22 — PDF Finalization Cleans Up an Uploaded Object on Any Transaction Failure, Not Just `insertFile`

### Decision

`processApprovalPdfJob`'s compensating-cleanup logic (delete the newly
uploaded PDF object if the DB write fails) was previously scoped only to
`repo.insertFile` throwing. Widened to cover the entire window from
`storageService.save()` through the transaction's own `COMMIT` — tracked
via a variable in the outer function scope, checked in a `try/catch`
around the whole `withTransaction(...)` call, since `COMMIT` runs only
after the transaction's callback has already returned successfully (see
`withTransaction`), meaning a `COMMIT`-time failure can't be caught by
anything inside that callback.

### Reason

A DB failure at `COMMIT` — after `insertFile`, `enqueue`, and the rawToken
update had all already "succeeded" inside the callback — previously left
the uploaded object with no compensating cleanup at all, since the
original `try/catch` had already exited normally by that point. Only an
object uploaded by the specific failed attempt is ever deleted; an
already-committed, already-referenced PDF found via `findLatestPdfFile` is
never touched.

### Status

Accepted.
