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

---

## 2026-08-22 — Reproducible Supabase Runtime Database Boundary

### Decision

Added an irreversible security migration that enables RLS on all 13 current
public tables and, when the Supabase roles exist, revokes table/sequence and
applicable default privileges from `anon` and `authenticated`. Runtime-role
creation and policies remain outside the migration so migrations do not depend
on the environment-specific `esdms_runtime` login already existing.

Reworked `scripts/provision-db-roles.sql` into an idempotent psql provisioning
step. The required `psql --no-psqlrc` invocation prevents user startup files
from running before the provisioning boundary, while script-level `\set ECHO
none` occurs before `\getenv` reads `ESDMS_RUNTIME_PASSWORD`; psql's quoted
variable form remains injection-safe for the `CREATE ROLE`/`ALTER ROLE`
password. The script verifies that `esdms_runtime` is a safe LOGIN role instead
of issuing the Supabase-incompatible role-attribute `ALTER`, removes the legacy
all-table, sequence, and default grants, and explicitly grants DML on only the
12 current application tables. It maintains one permissive
`esdms_runtime_access` policy per application table while leaving
`pgmigrations` RLS-enabled, unprivileged, and without a runtime policy.

### Reason

Supabase enables RLS but does not make the backend's database login usable by
itself: the runtime login needs a deliberate policy and table-grant allowlist.
Conversely, Supabase's browser-facing `anon`/`authenticated` roles must not
become an alternate route around backend authentication, authorization, and
site isolation. Automatic default grants also made every future module part of
the runtime trust boundary without a module-specific review and exposed the
migration-history table unnecessarily.

### Status

Accepted. The migration owner and running API credentials remain separate.
Every future table requires an explicit reviewed grant and RLS provisioning
update; production migration credentials must never be configured on the API.

---

## 2026-08-22 — Owner-Scoped Default ACLs and Public Function Execution

### Decision

Added a forward-only migration that revokes `EXECUTE` on current public
functions from `PUBLIC`, `anon`, and `authenticated`, and removes global plus
public-schema function defaults belonging to the migration owner. Trigger
functions remain usable through their table triggers without a direct runtime
function grant; they are not database APIs for browser roles.

Provisioning now removes legacy migration-owner table/sequence defaults for
`esdms_runtime`, removes migration-owner browser/function defaults, and verifies
only the default ACLs that govern objects created by `CURRENT_USER`. PostgreSQL
default ACLs are object-creator-specific, so unrelated `supabase_admin` defaults
do not govern ESDMS objects created by the `postgres` migration owner and are
neither altered nor treated as a provisioning failure.

### Reason

A controlled production run correctly failed closed when its earlier verifier
treated every owner's default ACL as part of one boundary. Read-only inspection
also showed PostgreSQL's default `PUBLIC EXECUTE` behavior on existing ESDMS
trigger functions. The corrected boundary removes current exposure and the
migration owner's future defaults while preserving Supabase-managed ownership
semantics.

### Status

Accepted. Browser authorization continues to flow exclusively through the
ESDMS backend; `anon` and `authenticated` receive no direct ESDMS table,
sequence, or function access.

---

## 2026-08-23 — Workforce Module Begun; Governance Roles Reuse `roles`, Not a New Column

### Decision

Gate Pass is now treated as a stable, protected existing ESDMS module; new
work targets the next business module, Workforce/Employee Management. First
foundation piece: four new application-authority roles — `CEO`,
`UPPER_MANAGEMENT`, `HR`, `EMPLOYEE` — inserted into the existing `roles`
table (migration `1787403000000_workforce-permission-foundation.js`), and a
new `user_permission_overrides` table giving per-user `GRANT`/`DENY` on top
of `role_permissions`. `getUserProfileById`
(`src/shared/users/user-profile.repository.js`) now computes "effective
permissions = role permissions + individual grants − individual denials" via
a `LEFT JOIN LATERAL` instead of the old plain `role_permissions` join —
provably unchanged for every existing user, since the override table starts
empty (see `test/effective-permissions.test.js`).

"Authority class" (CEO / Upper Management / HR / Employee) reuses the
existing `roles` table rather than adding a new `authority_class` column
somewhere else. A person's organizational title (Site Manager, CFO, General
Manager, ...) is a separate, not-yet-built concept — a future `positions`
table attached to the Employee record — independent of which `roles` row
their login account carries. This keeps "position ≠ application authority"
(the governance requirement) without inventing a second parallel
role-like concept before Employee Master exists to hang positions off of.

No permissions were granted to any of the four new roles in this migration,
and no API/UI exists yet to write `user_permission_overrides` rows — a user
in one of these roles can log in but holds zero permissions until a later,
separately reviewed change adds both. CEO self-protection (no one but CEO
can alter CEO, can't lock out the last CEO, etc.) is deferred to whenever
the actual user-management API is built; it isn't a schema concern.

This migration also adds the new table to `scripts/provision-db-roles.sql`'s
runtime grant/RLS-policy allowlist and to `test/db-privilege-boundary.test.js`
(as a new `RUNTIME_*` constant, kept separate from the existing
`APPLICATION_TABLES`/`ALL_TABLES` used by the test that parses
`1787401000000_database-runtime-security-boundary.js`'s own source text —
that migration predates this table and must not be edited to mention it) —
see `docs/SECURITY.md` §8.2.

### Reason

Every governance requirement in the Workforce spec (CEO overriding a role
grant with an explicit denial, HR not automatically inheriting salary
access, delegated history-correction authority) reduces to the same
"role ± individual override" primitive. Building that primitive first, as
its own small and independently regression-tested change, means every
subsequent Workforce piece (Employee Master, HR permissions, salary
permissions, contract permissions) is additive on top of an
already-proven mechanism rather than something that has to prove out the
authorization boundary itself later, under more schema weight.

### Status

Accepted. Full backend suite: 170/171 (the one failure,
`hostile runtime password quoting is injection-safe`, is a pre-existing,
local-Postgres-auth-config artifact unrelated to this change — present
before this migration too). Employee Master, Positions, and the
user-management/governance API remain unstarted.

---

## 2026-08-23 — Governance / User-Management Foundation

### Decision

Built the CEO/Upper-Management/HR authority layer the effective-permissions
primitive (previous entry) exists to serve, still deliberately ahead of
Employee Master. New module `src/modules/users/` (`POST /api/v1/users`,
`GET /:id`, `GET /`, `PATCH /:id/role`, `POST /:id/activate|deactivate`,
`GET/PUT/DELETE /:id/permissions[...]`), all gated by new permission codes
(`users.view/create/update/activate/deactivate/create_um/manage_um`,
`permission_overrides.view/manage` — migration
`1787404000000_governance-foundation.js`, following the existing
`module.action` code convention rather than the uppercase names used in the
originating request, per its own instruction to match repo convention).
Only `CEO` holds any of them at the role level; `UPPER_MANAGEMENT`, `HR`,
`EMPLOYEE` hold none, so "UM can't create UM" and "HR can't create CEO/UM"
fall out of the seed data rather than needing special-cased code.

**CEO bootstrap**: `scripts/create-ceo-user.js` (`npm run user:create-ceo`),
sharing `scripts/lib/bootstrap-user.js` with the existing
`create-admin-user.js` (extended/generalized rather than duplicated, per
instruction — see §12.1 in `docs/SECURITY.md`). `CEO` is excluded from the
API's assignable-role enum entirely, so no request, from any actor, can name
it as a target role.

**CEO protection**: centralized in one place,
`src/modules/users/users.authorization.js`'s `guardGovernanceTarget` /
`guardUmCreateAuthority`, used by every governance mutation:
1. a target whose *current* role is `CEO` is rejected outright, for every
   actor including another CEO — CEO succession is a separate, more
   sensitive operation, deliberately out of scope this increment;
2. an actor can never target their own account through any governance
   mutation endpoint — closes crafted-payload self-escalation and
   accidental self-lockout together;
3. touching an Upper Management account (as current role or as the role
   being assigned) additionally requires `users.create_um`/`users.manage_um`
   — holding `UPPER_MANAGEMENT` itself never implies it.

A blocked attempt against any of these is audited as
`PRIVILEGE_ESCALATION_ATTEMPT` (new `governance_audit_log` table, append-only
via the same `forbid_update_delete()` trigger `gate_pass_audit_log` already
uses) *before* the `403`, so a denied privileged request is never invisible.
Every successful governance mutation writes its audit row in the same
database transaction as the state change itself, so one can never happen
without the other.

**No `session_version` bump on role/permission/deactivation change.**
Investigated per explicit instruction to confirm whether one is needed:
`authenticate.js` already calls `getUserProfileById` fresh on every request,
and nothing about role, permissions, or active state is cached in the JWT —
the `role` claim `auth.service.js` signs into the token is never read back by
`authenticate.js`; only `sub` and `sv` are. A role change, permission
override, or deactivation is therefore already enforced on the *very next
request* under the same still-valid session cookie, which is a **stronger**
guarantee than a `session_version` bump would give (that would only force a
fresh login, not fix the current session's next request). Proven directly in
`test/governance.test.js` (grant/deny/role-change/deactivate, each verified
via the same pre-existing session cookie with no new login in between)
rather than asserted from reading the code alone.

**No hard delete.** Only activate/deactivate exist; no delete endpoint for
users was built, satisfying "historical actor after deactivation must keep
resolving" by construction — `governance_audit_log` (like
`gate_pass_audit_log`) references `users` with `ON DELETE RESTRICT`, which
would in any case make a hard-deleted, audit-referenced user impossible.

### Reason

Every invariant CEO/UM/HR governance needs (who can create whom, who can
touch a UM account, what happens to a denied attempt, whether a change is
felt immediately) reduces to a small, fully testable rule set once
centralized in one authorization module and one audit table — building it
now, isolated from Employee Master, means the next increment (Employee
Master, HR-delegated employee creation, salary/contract permissions) is
additive on top of an already-proven governance boundary instead of having
to prove that boundary out under more schema weight later.

### Status

Accepted. Full backend suite: 194/195 — 24 new tests (7 CEO bootstrap +
17 governance), zero regressions against the 171 that existed before this
increment. The one failure, `hostile runtime password quoting is
injection-safe`, is the same pre-existing local-Postgres-auth-config
artifact noted in the previous entry, present before this increment too —
not a new failure. Gate Pass regression suite (`test/authorization.test.js`,
`test/gate-pass-workflow.test.js`, `test/department-site-scope.test.js`,
`test/notification-site-scope.test.js`, `test/schema.test.js`) all still
pass unchanged; no Gate Pass route, permission code, or authorization
function was modified. Frontend: no changes this increment; `npm run lint`,
`npm test` (31/31), and `npm run build` all still pass, confirming that.

Deliberately deferred: Employee Master and Positions (next increment, by
explicit instruction); a `GET`/listing API for `governance_audit_log`
itself (nothing yet needs to read it back through the API — tests query the
table directly, the same way `test/schema.test.js` does for
`gate_pass_audit_log`); CEO succession/creation-of-additional-CEO through
the API (terminal bootstrap only, for now); salary/contract/compensation
permission codes (explicitly out of scope this increment); HR's actual
Workforce-scoped employee-creation permission (this increment proves the
delegation mechanism works — see the `users.create` grant to HR in
`test/governance.test.js` — but does not define the real HR permission set,
which belongs with Employee Master).

---

## 2026-08-23 — Workforce / Employee Management Module

### Decision

Built the full Workforce module the two prior increments' foundation
(effective permissions, governance/CEO protection) exists to serve: Employee
Master, Positions, Employment Types, effective-dated employment assignments,
onboarding with a forced-password-change first login, self-service profile
(personal details, emergency contacts, HR-configurable custom fields,
profile photo), employee documents (versioned, verified, expiry-aware, with
document-requests as a pending action), compensation (confidential,
effective-dated ledger), employment contracts (DB-enforced immutable once
finalized), rotation (policy + ledger, no auto-expiry), leave (explicit
state transitions only), CEO-only business-history removal, in-app
notifications (reusing the existing Gate Pass outbox unchanged), an
Employee Master Excel report, and a functional (not polished) frontend
slice. One migration per logical unit rather than per table
(`1787405000000_workforce-schema-foundation.js` bundles all 22 new tables'
schema + RLS + the governance-foundation permission-catalog pattern,
followed by `1787406000000_workforce-protected-audit.js` widening the
existing protected audit table, and `1787407000000_must-change-password.js`
for the one new `users` column) — see the two prior DECISIONS.md entries
for why bundling the DB-security-boundary work this way is the efficient
choice here.

**Architecture, in one sentence each:**
- **Employee ≠ User.** `employees` is the HR-authoritative core record;
  `employees.user_id` is a nullable, unique FK — an Employee can exist with
  no login, and a login can exist unlinked to any Employee.
- **Position/Department/Employment Type ≠ Role.** All three are plain
  reference data with zero relationship to `roles`/`role_permissions` — a
  Position literally named "CEO" grants nothing (proven directly in
  `test/workforce-foundation.test.js`).
- **Site/department/position/employment-type/rotation-policy/reporting-
  manager never overwrite.** `employment_assignments` is effective-dated
  history; "current" is the latest row whose `effective_date` has arrived,
  computed via a `LEFT JOIN LATERAL` (a SQL fragment, not a database VIEW —
  a view runs with its owner's privileges by default and could silently
  bypass a caller's RLS policy; see docs/SECURITY.md). A same-date correction
  upserts in place (two rows can't both describe "as of this exact date");
  any other date always inserts new history.
- **Contracts are the one thing even CEO cannot rewrite.** A DB trigger
  (`employee_contracts_enforce_immutability`) rejects any column change on a
  non-`DRAFT` row except the specific forward status transitions; effective
  dates are original terms and immutable too. A second trigger blocks
  `DELETE` once finalized.
  Enforced for every actor, proven both through the API and via a raw,
  direct SQL statement in `test/workforce-compensation-contracts.test.js`
  (bypassing the service layer entirely, as a compromised process or a
  careless psql session might).
- **Compensation is self-viewable but never self-changeable.** An employee
  sees their own current/historical compensation with no special permission
  (ordinary, expected — people know their own salary); anyone else needs
  the explicit, CEO-controlled `compensation.view`/`compensation.history`
  permission. No actor — including CEO — may ever record their own
  compensation change (`compensation.service.js`), mirroring the
  governance module's universal self-mutation block. Amount is never
  written into business-history or protected-audit metadata.
- **Every self-service route needs a password-change gate even without a
  permission check.** `requirePermission` (governance-foundation) already
  blocks `mustChangePassword=true` users, but self-only routes like
  `/me/profile` have no `requirePermission` call to hook into — a
  standalone `requirePasswordChanged` middleware, applied via `router.use`
  on every Workforce router, covers them. **A live browser smoke test
  caught a real gap this created**: the login response itself never
  included `mustChangePassword` (only `/auth/me` did), so a freshly
  onboarded Employee's very first page render had no way to know to
  redirect — the requirement only surfaced as a raw failed API call
  instead of the intended forced change-password screen. Fixed in
  `auth.service.js`; regression-covered in
  `test/workforce-foundation.test.js`.
- **Business history vs. protected audit, reused not duplicated.**
  `employee_business_history` (new, per-Employee, CEO-only logical removal
  with password re-confirmation — mirrors `docs/SECURITY.md`'s existing
  "strong confirmation" pattern) is the user-facing timeline.
  `governance_audit_log` (already built in the governance increment) is
  extended with `target_employee_id`/`target_contract_id` and new action
  codes rather than getting a second parallel protected-audit table — the
  original spec's own Protected Security Audit list already groups
  compensation/contract/employee events with user/permission events as one
  concept.
- **HR-created logins are role-EMPLOYEE by construction, not by check.**
  `createLoginForEmployee` never accepts a role parameter at all — there is
  no code path from an HR request to a privileged role, independent of any
  permission mistake (verified visually too: `AddEmployeePage.jsx` has no
  role field in its form).
- **Duplicate detection warns, never hard-blocks.** `POST /employees`
  checks CNIC/mobile/email/name-at-site matches and returns 409 with the
  match list; the same request resubmitted with
  `confirmDuplicateOverride: true` proceeds, and the override is recorded
  in the resulting business-history entry.
- **Storage namespace generalized, Gate Pass untouched.**
  `storage-service.js`'s `generateStorageKey` gained an optional
  `namespace` parameter (default `"gate-pass"`, so every existing Gate Pass
  caller is byte-for-byte unaffected) so Workforce files live under
  `workforce/...` instead of inside Gate Pass's own folder.
  Signature-based upload validation (photo, employee document, contract
  file) is deliberately re-implemented per module rather than shared with
  `gate-pass.upload.js` — see the module-boundary reasoning in
  `docs/MODULES.md` §13; Gate Pass code is not touched to enable reuse.
- **Excel export**: `exceljs` (new dependency) with a shared
  `sanitizeCell`/`safeExportFilename` helper (OWASP formula-injection
  mitigation — a leading `=`/`+`/`-`/`@`/tab/CR is quote-prefixed) used by
  every report, not reinvented per report. Compensation is only fetched (not
  just hidden) when the requester holds `compensation.export` — proven by
  asserting the raw workbook bytes contain no compensation column at all
  for an unauthorized exporter, not merely that the UI hides it.

### Reason

Same reasoning as the two prior increments: every governance/security
invariant this module needs (self vs. delegated access, effective-dating,
immutability, confidentiality, audit) reduces to a small set of primitives
already proven out in isolation — applying them consistently here, checkpoint
by checkpoint with tests after each one, means the highest-risk pieces
(contract immutability, salary confidentiality, CEO-cannot-self-serve) were
proven correct — including at the raw-SQL level, not just through the API —
before moving on to lower-risk pieces (rotation, leave, reporting).

### Status

At that pre-completion checkpoint, the full backend suite was 252/253 (24 new Workforce test files/253
total; the one failure, `hostile runtime password quoting is
injection-safe`, is the same pre-existing local-Postgres-auth-config
artifact noted in prior entries — confirmed unchanged, not a new failure).
Gate Pass + platform regression (`authorization`, `gate-pass-workflow`,
`gate-pass-pdf`, `department-site-scope`, `notification-site-scope`,
`schema`, `auth`, `config-validation`, `whatsapp-provider`,
`outbox-durability`, `health`, `storage-service`, `app-timezone`,
`create-admin-user`): 157/157, run explicitly and separately from the
Workforce suite. Frontend: `npm run lint` clean, `npm test` 31/31 (all
pre-existing), `npm run build` succeeds (PWA precache still generates); the
new Workforce screens themselves were exercised through a live Chrome
browser session against a running dev server (not just lint/build), which
is what caught the `mustChangePassword` login-response gap above. `npm
audit`: frontend clean; backend has the same pre-existing, non-exploitable
transitive `uuid` advisory as before (moderate, v3/v5/v6 buffer-bounds
issue — `exceljs`, the only consumer, uses only `uuid`'s v4 function,
confirmed by inspecting its source) plus this increment's own new direct
dependencies (`exceljs`, `archiver`) introducing no new advisories of their
own.

The following were deferred at that checkpoint and were subsequently
completed by the independent review entry below: bulk Excel employee import;
bulk ZIP document export
(`archiver` was added and is available for this, but the endpoint itself
is not built); a full report catalog beyond Employee Master (the
`sanitizeCell`/permission-gating pattern is established and ready to reuse
for the rest); temporary/short-term site assignments (schema only —
`temporary_assignments` table exists, no service/API); probation tracking;
rehire/employment-period modeling beyond a single continuous record;
Attendance integration (explicitly out of scope, by instruction); a
reusable Workforce correction/request mechanism for authoritative-field
change requests (only document requests were built as the one concrete
"pending action" case); saved filters/table preferences; a full
company-wide search; module-scoped (non-Workforce) custom fields; CEO/UM
governance and full HR-management screens beyond what was built (Employee
List/Detail/Add, Workforce Config) — CEO permission granting/restricting
and most cross-cutting reporting remain API-only, exercised by the test
suite rather than a UI, consistent with prioritizing backend
correctness/security over frontend breadth this pass.

## 2026-08-23 — Final Independent Workforce Review and Completion

### Decision

The independent release review verified the 22-table Workforce schema and
the 36-table runtime boundary, then completed the previously deferred V1
surface. Migration `1787408000000_workforce-release-hardening.js` is a
forward correction for worktrees/databases that already applied the draft
foundation: it adds `employees.bulk_import`, extends protected audit for
completed import, makes compensation append-only, protects stored document/
photo identity, and replaces the contract trigger so effective end date is
an immutable original term after finalization.

Verified release blockers were fixed rather than documented away: Workforce
password reset/status paths can touch only an ordinary linked `EMPLOYEE`
login; an inactive Employee cannot keep a login active through a client
flag; profile self-service honors effective DENY overrides; HR/management
custom-field visibility is no longer unioned; protected concepts are denied
in both custom-field key and label; request cancellation and version listing
are employee-owned and visibility checked; private API metadata no longer
exposes storage keys; and stored files are SHA-256 checked before contract
finalization/download, document/photo download, or bulk export.

The completed V1 adds signed preview/confirm XLSX import, 19 report catalog
entries, bounded streaming ZIP export, Workforce dashboard/operations/
reports, CEO/UM governance controls, expanded HR employee/configuration
screens, and complete employee self-service controls. Report downloads
require `employees.view` + report view + export, plus domain permissions for
documents, leave, rotation, compensation, and contracts.

### Deferred scope

Temporary assignments remain schema-only; probation, rehire/employment
periods, generic correction requests, advanced background exports, saved
views, Attendance, payroll/budget, Inventory/Procurement, and cross-module
search remain intentionally deferred. None is required for the implemented
V1 flows.

### Final verification state

The release-review test gate was run on the disposable local `.env.test`
database after the hardening migration completed a down/up cycle:

- focused Workforce plus CEO/UM governance: **102/102**;
- complete pre-Workforce/Gate Pass regression: **157/157**;
- complete backend: **268/269**. The sole failure is the independently
  reproduced hostile-password boundary assertion: this developer
  PostgreSQL host-auth configuration accepts the deliberately wrong
  password as well as the generated hostile password. The other **9/9**
  DB-boundary assertions pass. The test and production configuration were
  not weakened to turn that environment limitation green;
- frontend: **33/33**, ESLint clean, production/PWA build clean;
- full `npm audit` (including development tooling): **0 vulnerabilities** in both backend and
  frontend after pinning ExcelJS's transitive `uuid` to patched 11.1.1 or
  newer through an npm override.

These are local integration/build results, not deployment validation. No
production migration, user provisioning, Storage change, push, or deploy
was performed.

---

## 2026-08-23 — Pre-Pilot Security & Data-Integrity Hardening Pass

### Decision

An external audit of the Workforce module (findings ESDMS-001 through
ESDMS-041) was reviewed against current code and a first remediation pass
applied to the highest-priority findings per this repository's own stated
priority order (security, then data integrity, then authorization — see
`AGENTS.md` §3). This entry records what changed; a separate, much larger
remaining scope (frontend UI for governance/employee administration/
documents/contracts, mobile/responsive layout, visual design system,
accessibility, PWA offline-state handling, and further reporting/dashboard
work) is deliberately **not** covered here and remains open — see the
corresponding session's final report for the full accounting.

**ESDMS-001 — Governance-created User temporary password.**
`POST /api/v1/users` no longer accepts a caller-supplied `password` at all;
`users.service.js#createUser` generates one server-side
(`crypto.randomBytes(16)`), sets `must_change_password = true` (reusing the
existing forced-first-login mechanism Workforce onboarding already relies
on), and returns it in the response body exactly once. It is never logged
or persisted anywhere else.

**ESDMS-002 — Cross-site duplicate-check privacy.**
`employees.service.js#checkDuplicates` now redacts a duplicate match
outside the actor's own site scope (derived from `employeeSiteFilter`,
never a client-supplied site) down to a generic
`{ outOfScope: true, message: "..." }` — no id, code, name, status, or
which field matched. A company-wide (CEO) actor, or a same-site match,
still receives full detail. Applied to both the standalone duplicate-check
endpoint and `createEmployee`'s own duplicate-warning path, since both now
share the same redaction function.

**ESDMS-003 — Leave self-view/self-cancel identity shortcut.**
`leave.service.js#listMyOrEmployeeLeave` and `#cancelMyLeave` no longer
treat "this is the caller's own record" as sufficient by itself — an
explicit `leave.self.view` (for reads) or `leave.self.create` (for
cancellation) DENY now wins even for a self-directed request. The
management path (`leave.approve`/`leave.manage`) is consulted only for
non-self requests, so it can never be used to route around a self-view
denial for one's own record.

**ESDMS-004 — Login creation/linking must recheck ACTIVE status under lock.**
Both `POST /employees/:id/login` and `.../login/link-existing` now lock the
Employee row (`FOR UPDATE`, new `lockEmployeeById`) inside the mutating
transaction and re-verify status, linkage, and primary site from that
locked row — not the value read before the transaction began. Neither
route previously checked Employee status at all.

**ESDMS-005 — Offboarding policy for a privileged linked login.**
`changeEmployeeStatus` now blocks permanent offboarding only when the
linked login is both privileged (non-`EMPLOYEE` role) **and currently
active** — matching the intended workflow (Governance deactivates the
privileged account first; HR's offboarding then succeeds without touching
the now-inactive login's role). Previously it unconditionally blocked on
role alone, which would have kept blocking offboarding even after
Governance had already deactivated the account.

**ESDMS-033 — Employee status transition matrix and concurrency.**
`changeEmployeeStatus` now (a) locks the Employee row before validating the
transition, so a race with a concurrent status change is resolved by
whichever request's transaction commits first, and (b) validates the
transition against an explicit table — only `ACTIVE→{INACTIVE,RESIGNED,
TERMINATED}` and `INACTIVE→ACTIVE` are allowed; `RESIGNED→ACTIVE` and
`TERMINATED→ACTIVE` are explicitly rejected. A reason of at least 3
characters is now required at the validation layer for `RESIGNED`/
`TERMINATED`. Reactivating (`INACTIVE→ACTIVE`) still never touches a linked
login's active state — that remains an explicit Governance action.

**ESDMS-006 — Cross-site transfer.**
`createTransfer` rejects a cross-site transfer whose `effectiveDate` is in
the future (compared via `currentDateInAppTimezone()`, the business
timezone, not host-local time) — no scheduler exists yet for these. For an
effective-immediate cross-site transfer, an ordinary `EMPLOYEE`-role linked
login's `site_id` (and, if now mismatched, `department_id`) is synchronized
in the same transaction; a privileged linked login's site scope is never
touched and the response carries a `linkedAccountNote` saying Governance
must adjust it separately if needed.

**ESDMS-007 — Hidden document types leaking through reports.**
The `missing-required-documents` and `expiring-documents` report queries
(`reports.service.js`) now apply the same document-type visibility rule the
ordinary document APIs already use (`actor.role === 'CEO' OR
dt.hr_can_view`) — a hidden type no longer appears even as a "missing"
row.

**ESDMS-008 — Transactional consistency.**
`documents.service.js#requestDocument`, `leave.service.js#submitLeave`/
`#decideLeave`/`#cancelMyLeave`, and `profile.service.js
#updatePersonalDetails` previously wrote their primary row via the bare
pool and then wrote history/notification as separate, non-transactional
follow-up calls — a failure partway through could commit the business
mutation with no history/notification, or vice versa. All five now run
under one `withTransaction` client end to end. No external provider is
called inside any of these transactions; `notifyEmployee` only enqueues a
durable outbox row.

**ESDMS-012 — Document expiry analytics: latest version before
classification.** `documents.repository.js#listExpiring` (used by both the
`GET /documents/expiring` endpoint and, independently, the reports
catalog's `expiring-documents` entry) previously applied the
expiry-threshold `WHERE` filter *before* picking the latest version per
(employee, document type) — an obsolete, long-expired v1 could stand in for
a current, non-expiring v2 that itself didn't match the filter. Both
queries now resolve the latest version in a subquery first, then classify
it (`Expired` if `expiry_date < CURRENT_DATE`, `Expiring Soon` otherwise,
within the requested window).

**ESDMS-017 — Rate limiting behind a shared site NAT.**
`apiRateLimiter` (global per-IP) is raised from 600 to 3000/15min and
demoted to a broad abuse safety net; a new `apiUserRateLimiter` (600/15min
per authenticated user id) is applied inside `authenticate.js` — the one
choke point every authenticated request already passes through — once
`req.user` is resolved. Employees sharing one site's IP no longer share one
budget. `NotificationBell` (frontend) now pauses polling while the tab is
hidden, resumes without an immediate burst if it already polled recently,
and backs off (doubling, capped at 5 minutes) after a failed/429 poll
instead of retrying at fixed cadence.

**ESDMS-018 — Explicit self/management catalog context.**
`workforce-config.service.js#listFieldsForActor`/`#listDocumentTypesForActor`
previously inferred "self" purely from `!actor.permissions.has
("employees.view")` — an HR/UM/CEO actor viewing their *own* self-service
page would incorrectly receive the management-visibility catalog instead
of the self one. `GET /workforce-config/fields` and `.../document-types`
now require an explicit `?context=self|management` query parameter;
`management` additionally requires the actor actually hold a management
permission. The frontend's `MyWorkforcePage` (self-service) now calls the
`context=self` variants; `WorkforceConfigPage`/`EmployeeDetailPage`
(management) call `context=management`, matching what each surface is.

**ESDMS-020 — Password change now revokes every session (supersedes
nothing written above, but reverses the prior in-code design note in
`auth.controller.js`).** `POST /auth/change-password` now bumps
`session_version` and clears the session cookie on success — every
previously issued token for that user, including the one used to make the
request, stops working, and a fresh login is required. This was previously
deliberate ("the current session continues, no forced re-login") to avoid
an awkward loop right after forced onboarding; per this pass's approved
policy, a simple "log in again" after any password change is preferred
over the more complex alternative of keeping the current session alive
under a new token.

**ESDMS-021 — Safe production logging.** A new
`shared/logging/safe-logger.js#logServerError` replaces every
`console.error(rawError)` call on a request path (central error handler,
logout's revocation-failure path) and the two background paths (outbox
processor, storage cleanup). It logs a generated correlation id (also
returned to the client as `error.requestId` on a 5xx), method/route,
error name, and — only for `AppError` (a message this codebase authored
itself) — the message. An arbitrary/unexpected exception's own
`.message`/`.detail` (which, for a Postgres/driver error, routinely embeds
the actual submitted row values) is never logged. A stack trace is included
only outside production.

**ESDMS-035 — CEO/all-sites catalogs returning `[]`.**
`departments.controller.js#listAll` and `positions.controller.js#listAll`
previously special-cased `scope === null` (a company-wide actor) to return
`[]`, because the underlying repository queries didn't support a null
site filter. Both repository queries now accept `siteId = null` as "every
site" (`WHERE ($1::uuid IS NULL OR site_id = $1)`) and join `sites` for a
`site_name` column, so a CEO gets real company-wide results with meaningful
site identity instead of an empty list.

**ESDMS-040 — Reporting-manager cycle detection.**
`employees.repository.js#wouldCreateReportingCycle` replaced a hop-capped
(25) sequential walk — which could be bypassed by a hierarchy deeper than
the cap — with a single recursive CTE that walks the full current
reporting chain, guarded against infinite recursion by a `visited` array
rather than a hop limit. No depth can bypass it.

### Reason

Per `AGENTS.md` §3 and `docs/SECURITY.md` §2, security and data-integrity
findings take priority over authorization/UX findings, which in turn take
priority over polish. This pass worked through the highest-priority,
best-scoped findings first, each verified against current code (not
assumed from the audit report), fixed with the smallest correct change,
and covered by a new or updated backend test — see the corresponding
session's final report for the exact test names and full pass/fail
accounting.

### Status

Accepted. Full backend suite after this pass: 282/283 (the one failure is
the same pre-existing local-Postgres-host-auth artifact noted in every
prior entry — confirmed unchanged, not a new failure). Frontend: 34/34,
ESLint clean, production/PWA build clean. `npm audit`: 0 vulnerabilities,
both backend and frontend.

Not addressed in this pass — tracked as open scope, not silently dropped:
ESDMS-009 through ESDMS-011 and ESDMS-013 through ESDMS-016 (mobile layout,
governance/employee-administration/documents/contracts/configuration UI);
ESDMS-019 (historical Gate Pass department snapshot — needs a new forward
migration); ESDMS-022 through ESDMS-032 and ESDMS-036 through ESDMS-039
(mobile shell, dialogs, PWA offline/auth-state distinction, iOS file
viewing, visual design system, motion, workforce dashboard, accessibility,
contract/report timezone, leave/rotation policy conservatism, reporting
policy, remaining N+1/import review); and ESDMS-034 (a full route/
permission-matrix audit beyond the specific catalog-scope and
catalog-context findings fixed above). ESDMS-039 (query-string logging) was
explicitly out of scope for a route rewrite per instruction; the safe
logger above already ensures request query strings are never logged
verbatim as part of this pass's redaction work.

## 2026-08-25 — V1 Scope Narrowed to Procurement & Material Receiving (No Inventory Balance Yet)

### Decision

The first Inventory-adjacent module is **not** the full Inventory design
explored in Phase I (`docs/DECISIONS.md`'s earlier Inventory-must-wait
entry; see also the standalone Phase I domain/MVP specification produced
for owner review). Instead, V1 digitizes exactly:

```text
Department Material Catalog
        ↓
Demand List
        ↓
UM/CFO review
        ↓
Procurement pricing
        ↓
final approval
        ↓
IPO (auto-generated)
        ↓
purchasing
        ↓
Delivery Challan
        ↓
material receiving
        ↓
department confirmation / closure
```

Explicitly **not** built in this V1: current stock balances, an Available
Inventory calculation, a stock ledger, FIFO/batch consumption, Material
Issue, material usage, material return, stock adjustment, stock transfer,
warehouse/bin management, or any low-stock calculation derived from stock
transactions. Receiving V1 records **what was received**, never a computed
current-stock quantity — see `docs/PROCUREMENT_RECEIVING_SPEC.md` §24 ("No
Inventory Balance in V1"). The full Inventory module (ledger, balances,
issue/usage/return) remains a distinct, later project phase, introduced
only after an authoritative physical opening-stock count establishes a
cutover point.

The authoritative business specification for this scope is
`docs/PROCUREMENT_RECEIVING_SPEC.md` — it supersedes the placeholder
language in `docs/MODULES.md` §4-§6 the same way `docs/GATE_PASS_SPEC.md`
superseded the original Gate Pass placeholder.

### Reason

Owner instruction: get the Demand + Procurement + Receiving workflow
digitized and adopted by departments first, before building the more
complex stock-ledger machinery on top of it. This also directly satisfies
`docs/MODULES.md` §4's fourth Inventory prerequisite ("shared interfaces
required by Inventory have been identified") without requiring the
heavier ledger/balance design to be implemented speculatively ahead of
real operational feedback — see `docs/DECISIONS.md`'s "Inventory Must Not
Begin Before Gate Pass Stabilization" entry and the Phase I specification's
own MVP-boundary reasoning (§20 there: "smallest useful end-to-end slice",
now further narrowed by this explicit owner decision).

### Key structural decisions carried into the schema/authorization design

- **Every department owns its own material workflow.** Demand Lists,
  department material catalogs, and receiving records are department-
  scoped; Admin is not a universal approver/receiver. Enforced server-side
  via `material-catalog.authorization.js`'s `resolveCatalogDepartmentId`/
  `resolveListDepartmentScope`/`assertCatalogEntryManageable`, mirroring
  `workforce.authorization.js`'s `employeeSiteFilter` shape but keyed on
  department instead of site — and, unlike site_id (`NOT NULL` on every
  user), explicitly handling the case where `department_id` is null (an
  ADMIN/SITE_MANAGER/GATE_GUARD-style actor with no department must see
  nothing, never "everything", since a null scope would otherwise be
  ambiguous with a genuine company-wide grant).
- **Company Item vs. Department Material Catalog.** A Company Item is the
  global physical/material identity (so a future Inventory module never
  has to reconcile "the same physical material" recorded as unrelated
  objects per department); a Department Material Catalog entry is a
  department-scoped, reusable reference to one, carrying that
  department's own default Unit of Measure. Duplicate prevention is a
  search-then-warn UX, not a hard uniqueness constraint — the same
  "warns, not hard-blocks" convention Employee duplicate detection
  already established.
- **Gate Pass and Delivery Challan remain separate** (existing decision,
  reaffirmed): receiving does not depend on the Gate Guard, who continues
  to have zero procurement/inventory access and zero price visibility.
- **WhatsApp is not replaced in V1.** Delivery Challan/material-photo
  sharing continues over WhatsApp operationally; ESDMS is the
  authoritative workflow/history system but does not duplicate that
  communication channel in this phase.

### Status

Accepted. Checkpoint 1 (Material Catalog Foundation — Company Item,
Department Material Catalog, Units of Measure, and the `material_catalog.*`
capability set) is implemented: migration
`1787412000000_material-catalog-foundation.js`, backend module
`src/modules/material-catalog/`, frontend module
`frontend/src/modules/material-catalog/`. Demand List, UM/CFO review,
Procurement pricing/IPO, Delivery Challan, and Receiving remain later
checkpoints per `docs/PROCUREMENT_RECEIVING_SPEC.md`'s build sequence —
none of their schema/routes/UI exist yet. Existing Gate Pass and Workforce
behavior is unchanged; the full backend and frontend suites pass except
the same pre-existing local-Postgres-host-auth artifact noted in every
prior entry.

### Checkpoint 1 Finalization (same day)

Owner review caught one default-grant inconsistency before this migration
was ever committed: `UPPER_MANAGEMENT` had been given
`material_catalog.all_departments` by default, contradicting the already-
established Workforce precedent that UM's baseline is deliberately
conservative and never includes a broad-scope permission (`workforce.all_sites`
is likewise absent from UM's default set — see
`1787405000000_workforce-schema-foundation.js`'s `ROLE_PERMISSIONS`
comment). Corrected to `UPPER_MANAGEMENT: ["material_catalog.view"]` only,
in the still-uncommitted migration (no separate fix-up migration needed).
Two tests added proving the correction: UM cannot create in any
department, and UM cannot view another department's catalog by requesting
it explicitly (the same request a genuine all-departments actor — CEO — is
allowed to make).

A second, independent bug was found while adding a test for the
"similar names warn, don't block" requirement: the duplicate-warning
search reused the type-ahead search's one-directional `ILIKE` (existing
item name contains the query), so a new candidate name like "Cement Grade
A" never matched the shorter existing "Cement" it should have warned
about. Fixed with a dedicated `findSimilarCompanyItems` repository
function using a bidirectional `ILIKE` match, kept separate from the
type-ahead `searchCompanyItems` function (whose one-directional semantics
remain correct for that endpoint).

`docs/PROCUREMENT_RECEIVING_SPEC.md` gained three new sections (§35 Formal
PDF Documents, §36 Excel/Historical Data Export, §37 Audit/Log Management
Authority — all target design for later checkpoints, nothing implemented
in Checkpoint 1) and `docs/SECURITY.md` gained a new §14 documenting the
audit/log-management authority invariant as platform-wide, not
module-specific — CEO exceptional authority, per-user-delegable to a
specific UM member via the existing GRANT/DENY mechanism, never inherited
by UM as a whole, itself audited, and never weakening the existing
append-only DB-trigger guarantees.

Full backend suite after this correction: 388/389 pass — deduping the
duplicate `role_permissions` cleanup loop in the migration's `down()` (the
FK already cascades, per `1787347983007_rbac-foundation.js`) and the
correction above did not disturb the one pre-existing, unrelated
local-Postgres-host-auth failure. Frontend unaffected (no frontend files
touched in this correction pass).

## 2026-08-25 — Checkpoint 2: Department Demand List Foundation

### Decision

Implemented Procurement & Material Receiving V1's Checkpoint 2 per
`docs/PROCUREMENT_RECEIVING_SPEC.md`: department Demand List creation from
the department's own Material Catalog, Draft edit, and the `submit`
transition into `PENDING_INITIAL_REVIEW` with a first-review notification.
No approval action, no pricing, no IPO, no Delivery Challan, no Receiving,
no stock — those remain Checkpoint 3+.

### Key architectural decisions

- **Historical snapshot strategy** (required by the checkpoint's
  historical-design question: a future item rename or catalog archive must
  not corrupt an old Demand's meaning). A Demand line stores
  `item_name_snapshot`, `uom_code_snapshot`, `uom_name_snapshot` captured
  at creation time, alongside a live `catalog_entry_id` FK. Display always
  prefers the snapshot. Only name + UOM are duplicated — not description or
  any other catalog field — matching the instruction not to blindly
  duplicate everything. Line-to-catalog-entry ownership (a line must
  belong to the exact department its parent Demand belongs to) is pinned
  by a composite FK against a new `department_material_catalog_id_department_id_key`
  unique constraint, the same pattern `db-relational-coherence.js`
  established for `gate_pass_files`.
- **Demand numbering** mirrors Gate Pass exactly: a year-keyed
  `material_demand_number_counters` counter table, format
  `DL-YYYY-NNNNNN`, generated server-side inside the create transaction.
  No configurable numbering system (that's IPO's later, separate concern
  per the Phase I specification) — kept deliberately simple for V1.
- **`shared/authorization/department-scope.js` extracted.** Checkpoint 1's
  `material-catalog.authorization.js` had a department-scope
  implementation (the "department_id is nullable, unlike site_id, so null
  can't mean both 'unrestricted' and 'no department'" fix). Material
  Demand needed the identical rules, so the logic was extracted into a
  generic, permission-code-parameterized shared helper; both modules'
  `*.authorization.js` files are now thin pins over it
  (`resolveCatalogDepartmentId`/`resolveDemandDepartmentId`, etc.). Refactor
  verified behavior-preserving by re-running Checkpoint 1's full test suite
  unchanged before writing any Checkpoint 2 code — all 16 tests still
  passed with zero modification.
- **Notification routing: role + site, same mechanism as every existing
  ESDMS notification** (Gate Pass's `GATE_PASS_APPROVED` →
  `recipientRole: "GATE_GUARD"`). `DEMAND SUBMITTED` enqueues one `IN_APP`
  row for `UPPER_MANAGEMENT` and one for `CEO`, both scoped to the
  Demand's `site_id`, in the same transaction as the status change.
  Correct for `UPPER_MANAGEMENT` (already site-scoped by default). A
  **known, narrow, deliberately deferred gap for `CEO`**: CEO's authority
  spans every site, but this mechanism only notifies a CEO account whose
  own `site_id` matches the Demand's site — a genuinely multi-site
  deployment could have a Demand at a site with no matching CEO recipient.
  CEO's *view* authority is unaffected (still reachable by browsing); only
  the in-app notification bell would miss it. The real fix is
  capability-driven (not role-string-driven) notification routing,
  deferred to Checkpoint 3 alongside the real review/final-approval
  capabilities that make it necessary. Documented rather than silently
  built around, per this checkpoint's explicit instruction to defer exact
  reviewer routing safely rather than build it wrong.
- **`demand.*` capability defaults mirror Material Catalog's
  already-corrected pattern exactly**, applying the same lesson before it
  could be gotten wrong twice: `UPPER_MANAGEMENT` gets `demand.view` only
  (no `.all_departments`); `ADMIN`/`SITE_MANAGER`/`TEAM_LEAD` get
  create/edit/submit scoped to their own department only (no
  `.all_departments`); `EMPLOYEE` gets view only; `GATE_GUARD` gets
  nothing; only `CEO` gets `demand.all_departments`.
- **Department is immutable on an existing Demand.** Unlike Gate Pass
  (which allows changing `issuingDepartmentId` on a Draft), a Demand's
  department cannot be changed after creation — lines are
  composite-FK-pinned to a specific department, so changing the parent
  would require re-validating and re-pinning every existing line. Simpler
  and safer for V1; revisit only if real usage shows a need to move an
  entire Draft between departments (unlikely — a Draft with the wrong
  department is cheap to delete and recreate while nothing else references
  it yet).
- **Submit-time validation scope.** Of the checkpoint's required submit
  checks (line count, quantity > 0, valid catalog relationship, no
  duplicate lines), only "at least one line" is actually re-checked at
  submit — the other three are structurally guaranteed at write time
  (Zod validation + DB `CHECK`/FK/`UNIQUE` constraints), so a persisted
  line cannot violate them and a redundant re-check at submit would be
  dead code. Documented here rather than left implicit, since the
  checkpoint instructions listed all four as things "the server must
  verify."

### Frontend decisions

- **Department name not shown on a brand-new empty Draft for a
  department-locked actor** (e.g. "New Demand" rather than the mockup's
  "New Demand — Civil"). No existing endpoint lets a Demand-only actor
  (holding no Gate Pass/Workforce permission) cheaply resolve their own
  department's name — `/auth/me` returns only `departmentId`, and
  `GET /departments` / `GET /departments/manage` are both gated by
  Gate-Pass/Workforce permissions a pure Demand creator may not hold.
  Once a Demand exists (edit/detail), its `department_name` comes for
  free from the existing list/detail join, so this gap is cosmetic and
  narrow (one page, one moment) rather than a functional limitation — not
  worth adding a new "my department" endpoint or widening an unrelated
  module's permission gate for.
- **`AuditTimeline` duplicated, not extracted to `shared/`,** despite
  Gate Pass having an near-identical component. The two modules' action
  codes only partially overlap (`CREATE`/`EDIT_DRAFT`/`SUBMIT` vs. also
  `APPROVE`/`REJECT`/`CANCEL`/`EXIT`/`RETURN`), and extracting it mid
  checkpoint would have meant touching Gate Pass's existing, regression-
  protected frontend for a purely cosmetic component. Flagged here as a
  minor, low-risk cleanup opportunity for whenever Gate Pass's frontend is
  next touched anyway — not done opportunistically now.

### Status

Accepted. Migration `1787413000000_material-demand-foundation.js`; backend
module `src/modules/material-demand/`; frontend module
`frontend/src/modules/material-demand/`. New shared helper
`src/shared/authorization/department-scope.js`. Full backend suite:
406/407 (the one failure is the same pre-existing local-Postgres-host-auth
artifact noted in every prior entry). Frontend: 216/216, ESLint clean,
production/PWA build clean. `npm audit`: 0 vulnerabilities, both packages.
Gate Pass and Workforce regression suites unaffected (no files in either
module touched). Checkpoints 3-8 (Initial Review through Closure) remain
unimplemented per `docs/PROCUREMENT_RECEIVING_SPEC.md` §0.

## 2026-08-26 — Checkpoint 3: Initial Management Review + Formal/CFO Approval + Procurement Handoff

### Decision

Implemented Procurement & Material Receiving V1's first approval gate:
`PENDING_INITIAL_REVIEW` → (Management Review **and** Formal Approval,
both `APPROVED`) → `READY_FOR_PRICING`, or either `REJECTED` →
`REJECTED`. No Procurement pricing screen/workflow, no second
(post-pricing) approval gate, no IPO, no Delivery Challan, no Receiving,
no stock — those remain later checkpoints.

### Key architectural decisions

- **Two independent capabilities, one gate.** `demand.review`
  (Management Review) and `demand.approve` (Formal/CFO Approval) are
  separate capabilities — neither implies the other, and route-level
  `requirePermission` enforces this before either service function is
  ever reached. Both are required; the gate does not care which is
  decided first.
- **Action capability and record scope remain separate.** Holding
  `demand.review` or `demand.approve` authorizes that action but does not
  grant cross-site access. A capable Management Reviewer/Formal Approver
  is authorized across every department **at their own site**; CEO or a
  separately effective `demand.all_departments` scope grant reaches every
  site. This mirrors Gate Pass's existing site-scope shape and is distinct
  from Checkpoints 1-2's department-only creator model. Implemented as
  `assertReviewActionAllowed`/`resolveDemandListScope`'s `SITE` tier in
  `material-demand.authorization.js`, layered onto (not replacing) the
  existing `OWN`/`ALL` tiers the creator's own view/edit/submit authority
  still uses.
- **First writer wins, enforced by the database, not just application
  logic.** `material_demand_approvals` has `UNIQUE(demand_id, revision,
  approval_type)` — a second decision attempt for an already-decided slot
  fails at the database, giving concurrent-approval race safety for free
  once combined with the existing `lockById` row-lock pattern (verified
  under an actual concurrent request pair in
  `material-demand-approval.test.js`, not just asserted).
- **A single ordinary user cannot fill both slots on one Demand — CEO is a
  deliberate, documented exception.** Enforced in
  `recordApprovalDecision`: before inserting a decision, check whether the
  *same actor* already recorded the *other* slot for this demand+revision;
  reject unless `actor.role === "CEO"`. This was an explicit requirement
  (not merely "don't accidentally allow it") — CEO's exceptional,
  already-established platform authority is the one deliberate carve-out,
  chosen over inventing a new "override" capability for something CEO
  already implicitly has the authority to do end-to-end.
- **Approval history is genuinely immutable, and revision-bound.**
  `material_demand_approvals` reuses the existing `forbid_update_delete()`
  trigger (same guarantee as `gate_pass_audit_log`) — no actor, including
  CEO, can edit or delete a recorded decision. Every row records the
  Demand's `revision` at decision time; no reopen/new-revision workflow
  exists yet in this checkpoint, so "stale revision" rejection could not
  be exercised end-to-end (there is no way yet to advance a Demand's
  revision past `1`) — the binding itself is implemented and tested
  (the recorded revision matches the demand's current revision), and
  Checkpoint 4+'s reopen work will be what exercises the stale-revision
  rejection path for real.
- **Capability-driven recipient resolution replaces Checkpoint 2's
  role+site mechanism entirely, resolving its documented gap.** New
  `src/shared/notifications/recipient-resolver.js#resolveEligibleRecipients`
  reuses `getUserProfileById`/`isProfileActive` — the single authoritative
  effective-permissions computation `authenticate.js` already uses — to
  answer "which active users are actually eligible right now?" rather than
  writing a second, hand-rolled reverse-direction SQL query that could
  diverge from it. One `IN_APP` row per eligible user, deduplicated across
  capabilities, with a recipient-specific idempotency key. This is a
  platform-reusable primitive (`shared/notifications/`, not
  material-demand-specific) — see `docs/SECURITY.md` §11. It resolves the
  CEO cross-site notification gap Checkpoint 2 explicitly flagged as
  deferred: CEO eligibility is checked directly (`profile.role === "CEO"`),
  never via a site-matched recipient row, so it no longer depends on which
  site happens to match a CEO account's own `site_id`.
- **`procurement.pricing` introduced now, deliberately minimal.** The
  Ready-for-Pricing notification needed a real capability to route
  through rather than a hardcoded role, but Checkpoint 4 (which defines
  the actual pricing workflow) hasn't happened yet. CEO is the only
  default holder; actual Procurement staff receive an explicit per-user
  GRANT. ADMIN is not a default holder because system administration and
  Procurement are separate responsibilities. No PROCUREMENT role is
  invented here.
- **Rejection is immediate and unilateral; positive history is never
  erased.** Either slot's `REJECTED` moves the Demand straight to
  `REJECTED` without waiting for or requiring the other slot's decision.
  An already-recorded `APPROVED` decision on the other slot is preserved
  as a permanent historical fact (append-only table, nothing to erase) —
  proven in `material-demand-approval.test.js` by rejecting after a prior
  approval and asserting the approval row is unchanged.

### Bugs found and fixed during this checkpoint (before any commit)

- **`lockById` never selected `revision`.** Every reference to
  `demand.revision` in the service (idempotency keys, approval records)
  was silently `undefined`. Found via a test assertion on a specific
  recipient's idempotency key failing with count 0 instead of 1 — fixed by
  adding `revision` to `lockById`'s column list. This affected Checkpoint
  2's own idempotency keys too (they were already using
  `demand.revision`, just never noticed because Checkpoint 2's tests only
  checked aggregate row counts, not exact keys) — a good example of why
  the "delta/exact-key" test design adopted below matters.
- **`material_demand_audit_log.action` was `varchar(20)`**, sized for
  Checkpoint 2's three short action codes. Checkpoint 3's decision-outcome
  codes (`MANAGEMENT_REVIEW_APPROVED`, 26 characters) don't fit. Found via
  a live `22001` (string data right truncation) Postgres error surfaced
  through the full test run, not caught by any static check — fixed by
  widening the column to `varchar(30)` in the same migration that adds
  the new action codes to the `CHECK` constraint.
- **Test design fix, not a product bug:** the original
  "replayed Submit does not duplicate notifications" test from Checkpoint
  2 asserted an exact row count of 2, which broke the moment recipient
  routing became genuinely capability-driven — the real count depends on
  how many actual users in the (shared, cross-test-file) test database
  effectively hold `demand.review`/`demand.approve` at that site, which
  is legitimately larger than the fixed `seedUsers()` set once other test
  files' accumulated fixtures are included. Rewritten to assert the
  correct invariant instead: a replay must not change the row count
  (delta-based), and a specific known-eligible recipient's exact
  idempotency key must exist exactly once. Every new Checkpoint 3
  notification test follows this exact-key pattern rather than counting
  all rows for an entity, precisely to avoid this class of fragility.

### Status

Accepted. Migration `1787414000000_material-demand-initial-approval.js`;
new shared `src/shared/notifications/recipient-resolver.js`; backend
module changes in `src/modules/material-demand/` (constants,
authorization, repository, service, controller, routes); frontend
`components/ApprovalPanel.jsx` + `DemandDetailPage.jsx` changes. New
backend test file `backend/test/material-demand-approval.test.js` (34
tests: capability separation, scope, gate completion in both orders,
concurrency, replay, same-actor guard, rejection, revision binding,
approval immutability, and recipient resolver GRANT/DENY/inactive/site/
dedup behavior for both review and Procurement pricing). Full backend suite:
440/441 (the one failure is the same pre-existing local-Postgres-host-auth
artifact noted in every prior entry). Frontend: 223/223, ESLint clean,
production/PWA build clean. `npm audit`: 0 vulnerabilities, both packages.
Gate Pass and Workforce regression suites unaffected. Migration `up`
verified (including a full down/up cycle immediately after authoring it,
before any data existed under the new schema); a later `down` attempt —
made only after the full test suite had already populated
`material_demand_audit_log` rows using the new action codes — correctly
fails with a `CHECK` constraint violation, the expected and correct
Postgres behavior for downgrading a schema after data using its new
capability already exists (not a defect; the same category of
irreversibility `1787401000000_database-runtime-security-boundary.js` is
explicit about). Procurement pricing through Closure (checkpoints 4-8)
remain unimplemented per `docs/PROCUREMENT_RECEIVING_SPEC.md` §0.

## 2026-08-26 — Checkpoint 4: Procurement Estimated Pricing + Second-Gate Notification Foundation

### Decision

Implemented only `READY_FOR_PRICING → PENDING_FINAL_APPROVAL`: authorized
Procurement saves exact PKR estimated market unit prices against every line
of the current Demand revision, then explicitly submits them. Final
management/formal approval actions, IPO, purchasing, actual price/quantity,
Delivery Challan, receiving, stock, exports, PDFs, and WhatsApp remain out
of scope.

### Durable design choices

- **Pricing is a separate sensitive domain.** New backend/frontend
  `modules/procurement/` owns protected queue/detail/save/submit behavior;
  `material_demand_pricing` and `material_demand_pricing_lines` are never
  joined into ordinary Demand GETs. React visibility is not the security
  boundary.
- **Estimated, previous, and actual prices are distinct.** Checkpoint 4
  stores Estimated Market Price only. Previous Purchase Price will be
  derived from future actual purchasing history or a deliberate legacy
  import; it is not an editable placeholder and is never inferred from an
  estimate. Actual Purchase Price remains unimplemented.
- **Exact money and server totals.** Currency is explicit `PKR`; prices are
  positive `numeric(14,2)`. The API accepts plain decimal strings and no
  claimed totals. PostgreSQL recomputes quantity × unit price and the grand
  total with exact numeric arithmetic.
- **Revision binding and relational ownership.** One pricing header exists
  per (`demand_id`, `demand_revision`). Composite foreign keys require
  every pricing line and referenced Demand line to belong to the same
  Demand; no item/UOM snapshots are duplicated.
- **Capability and scope stay separate.** `procurement.pricing` remains
  CEO-only by default and is explicitly granted to actual Procurement
  staff. New `procurement.view_prices` defaults to CEO,
  UPPER_MANAGEMENT, and SITE_MANAGER. ADMIN has neither by default. A
  capable non-broad actor works across departments at their own site only;
  CEO or an explicit `demand.all_departments` scope grant reaches all
  sites. Effective DENY wins.
- **Drafts are mutable; submitted pricing is not.** Service checks and
  database triggers reject update/delete after submission. The line trigger
  locks the parent header, while save and submit both lock Demand then
  pricing in the same order, preventing an edit from landing after the
  values become the final-review basis.
- **One atomic, replay-safe submission.** Submission locks and revalidates
  current status/revision/line coverage, finalizes pricing, transitions the
  Demand, appends pricing/transition audit rows, and enqueues recipient rows
  in one transaction. A committed replay is a successful no-op.
- **Final-gate routing remains capability-driven.** The shared recipient
  resolver selects active, in-scope effective holders of `demand.review`
  and `demand.approve`, including per-user GRANT/DENY and CEO authority.
  One price-free notification per user uses the stage-specific
  `...:final-review:{userId}` key. Checkpoint 5 will add the actions.

The migration adds two RLS-enabled application tables and two hardened
trigger functions; the runtime boundary is now 46 application tables (47
including owner-only `pgmigrations`).

## 2026-08-26 — Checkpoint 5: Final Pricing Approval + Controlled Repricing Foundation

### Decision

Implemented `PENDING_FINAL_APPROVAL → READY_FOR_IPO` through two immutable
FINAL decisions, plus the rejection path
`PENDING_FINAL_APPROVAL → PRICING_REVISION_REQUIRED → READY_FOR_PRICING`
that creates a new immutable Pricing version. `READY_FOR_IPO` is the stop
boundary. No IPO entity, number, document/PDF, purchasing, actual price or
quantity, DC, receiving, inventory, or export was introduced; official IPO
design awaits the owner's real E-Set IPO/Demand/DC documents and numbering
examples.

### Durable design choices

- **Approval stage and Pricing identity are structural.** Existing approval
  rows are preserved as `INITIAL`. FINAL rows require a `pricing_id`, and a
  composite foreign key proves that Pricing belongs to the same Demand and
  Demand revision. Partial unique indexes provide one INITIAL responsibility
  per revision and one FINAL responsibility per exact Pricing version.
- **Responsibilities reuse capabilities.** FINAL Management Review requires
  `demand.review + procurement.view_prices`; FINAL Formal/CFO Approval
  requires `demand.approve + procurement.view_prices`. Scope remains a
  separate same-site/company-wide decision. No CFO role or `demand.final_*`
  capability was invented; Upper Management still has no default Formal
  Approval, and a real CFO receives explicit GRANTs.
- **Same-actor governance is per stage and Pricing version.** An ordinary
  actor cannot fill both FINAL slots for one Pricing version. CEO retains the
  documented exception. The same actor may hold their corresponding INITIAL
  and FINAL responsibility because those are separate gates.
- **One coherent terminal result under concurrency.** Every final action
  locks Demand then the current Pricing header, matching save/submit/repricing
  lock order. Two approvals yield exactly one `READY_FOR_IPO` transition; a
  committed rejection makes later work on that round stale, so approval can
  never complete the gate after rejection.
- **Repricing creates history, never edits it.** `material_demand_pricing`
  now has a positive server-sequenced `version`; multiple SUBMITTED versions
  may exist but a partial unique index permits only one DRAFT. Only
  `PRICING_REVISION_REQUIRED` can create the next version. Lines are copied as
  an editable starting point, while every prior submitted header/line remains
  protected by the existing database triggers.
- **Protected rejection context.** The required FINAL rejection reason lives
  on the append-only approval row and is returned only through the protected
  Pricing resource. Ordinary Demand detail exposes workflow state and final
  progress but redacts the reason; the operational audit and notification
  payloads contain Pricing identifiers/version, never prices or the reason.
- **Notifications are version-specific.** Final-gate recipients are the
  intersection of the relevant action capability and
  `procurement.view_prices`. Submission keys are
  `...:pricing:{version}:final-review:{userId}`; rejection keys are
  `...:pricing:{version}:repricing-required:{userId}`. A prior round cannot
  suppress notifications for a resubmission.
- **No new database trust surface.** Migration
  `1787416000000_material-demand-final-pricing-approval.js` changes existing
  RLS-enabled tables only, creates no application table/function, and leaves
  the 46-table runtime allowlist unchanged. Its down migration explicitly
  refuses to destroy FINAL decisions or Version 2+ pricing history.

---

## Procurement & Material Receiving V1 — Checkpoints 6-8 (IPO, Purchasing, Delivery Challan, Receiving, Documents, Exports)

### IPO generation is automatic and exactly-once by database constraint

The owner ruled out a manual "Generate IPO" step. The IPO is therefore
created inside the very transaction that completes final approval, under the
Demand row lock that transaction already holds.

Correctness does not rest on that lock alone: `unique (demand_id,
demand_revision)` on `ipos` means a replayed request, a double-click or two
approvers completing the gate concurrently can only ever conflict, never
produce a second IPO. `generateIpoForApprovedDemand` pre-checks the same
condition so a replay is a silent no-op rather than a constraint violation
the caller must interpret.

`READY_FOR_IPO` was kept as a real, audited boundary in the history rather
than deleted — but it is no longer a resting state, so the Demand's visible
status moves straight to `IPO_GENERATED`. Checkpoint 5's existing tests were
updated to assert the new status **and** the existence of exactly one
correctly-bound IPO; that is a strengthening, not a weakening.

### Document numbering is configuration, not a numbering engine

Issuance reuses the existing atomic year-keyed counter pattern from Gate
Pass and Material Demand verbatim (`INSERT .. ON CONFLICT DO UPDATE ..
RETURNING`, which row-locks the counter). The only thing added is that the
FORMAT is data: `document_number_settings` holds prefix, separator, suffix,
pad width and start value per document type, so the authentic E-Set
`ESET/2026/32` format is a seeded row rather than a string literal, and
changing it later cannot restate an already-issued number (the formatted
string is persisted on the document itself). Cancelled numbers stay
consumed; counters never roll back.

A consequence worth recording: a real reference contains `/`. Every download
filename is therefore derived through `documentFilename()`, which allowlists
`[A-Za-z0-9_-]` and excludes `.` from the base name, so no reference can
reach a filesystem path or a `Content-Disposition` header unescaped.

### A line-level exclusion is a decision, not a deletion

Management routinely funds most of a Demand and marks one line "out of
budget". That is stored in its own table (`material_demand_line_dispositions`)
rather than as a column on `material_demand_pricing_lines`, because a pricing
line is Procurement's immutable submitted estimate while a disposition is a
management decision taken against that exact version. Keeping them apart
means recording "excluded" never mutates — and can never appear to have
altered — the submitted commercial estimate.

The excluded line, its quantity, its pricing version and its estimate all
survive intact, and the decision snapshots quantity and estimate itself. A
line with no row is implicitly `APPROVED_FOR_PURCHASE`, so no historical row
needed backfilling. Excluding every line is refused: that is a rejection,
which already has its own audited path.

**Determinism of the approved set** (the requirement that a prior Formal
Approval must not silently remain authoritative over a changed set) is
enforced by a trigger that freezes every disposition for a Pricing version
the moment its FIRST final decision is recorded. Changing the set afterwards
requires rejection and a new immutable Pricing version — reusing Checkpoint
5's philosophy rather than inventing a second one.

### Previous Purchase Price matches on item identity, never on description

The lookup is keyed on `company_item_id`, snapshotted onto `ipo_lines` at
generation time, and reads only ACTUAL finalized purchase prices — never an
old estimate. "Screw 1/2 inch" and "Screw 2 inch" are different Company
Items and can never share price history; fuzzy search assists catalogue
discovery only and never determines financial identity.

Arithmetic is exact: both prices convert to integer minor units as BigInt,
so no float ever touches money. Only the percentage is a genuine ratio,
computed at two decimals with explicit half-away-from-zero rounding. With no
prior purchase the API returns `null` and the UI states "No previous
purchase history" — deliberately not `Rs 0` or `0%`, which would falsely
assert that the price had not moved.

### Conservative IPO cancellation policy while the business rule is open

The owner's rule for "cancel after purchasing has started" is unresolved. V1
therefore refuses cancellation outright once any purchase is recorded or a
live Delivery Challan exists, rather than guessing at a compensating action.
Real recorded purchases are never silently voided; outstanding quantity is
resolved through explicit purchasing closure instead. This is a documented
conservative choice, revisitable when the owner settles the policy.

### Closure is evaluated, never asserted

A Demand/IPO/DC chain closes only when every quantity is resolved:
Procurement has explicitly closed purchasing (making any unpurchased
approved quantity deliberate, traceable carry-forward), every purchased
quantity is on a Delivery Challan, and every challan is COMPLETED (fully
received AND department-confirmed) or CANCELLED. `COMPLETED` means the
digital workflow is finished — never that material was consumed, and never
that any stock level is known.

### One lock order for the whole chain

**Demand → Pricing → IPO → Delivery Challan → Material Receipt.** Every
writer takes the subset it needs in that order and re-validates state only
after acquiring the locks; unlocked reads exist solely to discover which
parent rows to lock.

This was not free: the system-wide concurrency review found that
`closePurchasing` originally locked the IPO before the Demand, inverting the
order used by receipt confirmation and opening a deadlock window between
Procurement closing purchasing and a Team Lead confirming the last receipt.
It was corrected to lock the Demand first, and a concurrency regression test
now exercises both paths simultaneously.

### Existing infrastructure reused rather than duplicated

- WhatsApp document delivery reuses the Gate Pass SYSTEM-job → WHATSAPP-job
  outbox chain, and `notification_outbox` IS the delivery record (channel,
  destination, status, attempts, last error, provider message id,
  idempotency key, timestamps). No parallel delivery-history table was
  created. `DISABLED` was added as a status so a deliberately unattempted
  delivery is neither stuck pending nor misreported as failed.
- Only the official WhatsApp Business Platform is supported. Unofficial
  automation (Web scraping, headless browsers, reverse-engineered session
  libraries, personal-account sessions) is permanently out of scope.
- One append-only `procurement_audit_log` covers IPO, Delivery Challan and
  Receiving, keyed by `ipo_id`. Those are three bounded modules but one
  physical purchasing chain, and a single entity-tagged stream is exactly
  what the traceability view reads — the same shape `governance_audit_log`
  already uses across Workforce modules.
- Record scope for all three chain modules is one shared resolver
  (`supply-chain-scope.js`) reusing Material Demand's three-tier shape, not
  three near-identical implementations.
- Excel export reuses the existing `excel-safety.js` primitives and the
  `WORKFORCE_EXPORT_GENERATED` audit precedent.

### Delivery Challan stays separate from Gate Pass

Reaffirmed and now enforced: the two share no foreign key in either
direction, and a Delivery Challan id is not addressable through the Gate
Pass API. Both properties are asserted by test.

### New database trust surface

Six migrations (`1787417000000`-`1787422000000`) add eleven application
tables. All have RLS enabled, explicit runtime grants and a single runtime
policy; the provisioning script's explicit grant allowlist, dynamic RLS/policy
verification, and `test/db-privilege-boundary.test.js` were updated together. Every
foreign key has an indexed leading column, no money or quantity column uses
a floating-point type, and every nullable column is a genuinely optional
lifecycle field bound by a CHECK constraint. Each down migration refuses to
destroy issued numbers, purchasing history, receiving history or management
decisions.

---

## Procurement & Material Receiving V1 — Corrective Pass After Independent Review

An independent adversarial review of the completed V1 found a set of real
defects. Each was fixed at its root with the smallest safe change; no module
was rewritten and no working architecture was replaced.

### Admin fallback authority is contextual, not a scope tier

The generic supply-chain scope resolver treated `receiving.fallback_receive`
as a site-wide capability, which silently gave ADMIN cross-department read
access to every IPO, Delivery Challan, receiving record, carry-forward source
and Procurement export at their site. That is far more than the business rule
grants.

The capability was removed from `SITE_WIDE_PERMISSIONS` entirely. Fallback
authority now reaches exactly three things, in the receiving module only: the
queue of deliveries at the actor's own site that are still open for receiving,
the detail of such a delivery, and recording a fallback receipt against one.
It expires the moment the delivery closes. Receiving history is not widened at
all — a fallback custodian sees only receipts they personally recorded or took
handover of. IPO, purchasing, exports and all commercial surfaces are
unaffected by holding it.

### Carry-forward is an authoritative claim, not a suggestion

Carrying an unresolved quantity into a later Demand left no claim against its
source, so the same outstanding 40 could be carried into Demand A, B and C and
each would look legitimate. `carry_forward_allocations` now records the claim
with a real foreign key to its source, and availability is always
`source_quantity` minus every ACTIVE claim.

Three sources, chosen because they cannot overlap: `UNPURCHASED_IPO_QUANTITY`
(approved, ordered, but purchasing closed short), `OUT_OF_BUDGET` (excluded
from the set that became purchasing authority, so never ordered) and
`RECEIVING_SHORTAGE` (purchased and delivered, but confirmed short). The first
two are quantities never bought; the third was bought. The same unit can
therefore never be counted twice.

**The claim becomes authoritative at SUBMIT, not while drafting.** A
reservation taken because someone opened a form would either leak — abandoned
drafts holding quantity indefinitely — or need an expiry mechanism this scale
does not justify. Submitting is when the department commits to the request, so
that is when the quantity is committed. A Demand that dies (rejected, or whose
IPO is cancelled) releases its claim; the row is marked RELEASED, never
deleted.

### Request idempotency, because the network is not reliable

Quantity constraints could not distinguish a genuine second partial receipt
from a retry of the same one, so a lost HTTP response meant 20 units received
became 40 recorded. Receiving, Delivery Challan creation and purchasing now
each take a client-generated `operation_id`, unique at the database level. A
replay returns the record that already exists — no second receipt, no second
challan, no second DC number, no second purchase, and no second audit event,
because nothing actually happened.

### Purchasing is an event log, not a cumulative field

One IPO line is realistically bought more than once at different prices (60 @
100, then 20 @ 110). A single `purchased_quantity` plus one `actual_unit_price`
could not represent that without silently destroying the first transaction and
restating it as 80 @ 110.

`ipo_purchase_events` now records each purchase as its own append-only event.
The line-level total is derived from them, and a deferred constraint trigger
proves the stored aggregate always equals the sum of the events — a total
cannot be fabricated without the events behind it. A mistake before closing is
corrected with an explicit negative-quantity reversal event, so the original
entry stays readable rather than being edited away. Once purchasing is closed,
a trigger freezes the purchasing facts for every writer.

### Previous Actual Price requires finalized purchasing

It previously accepted any non-cancelled IPO with a price recorded, including
purchases still in progress that could still move. It now requires
`purchasing_closed_at IS NOT NULL` on a non-cancelled IPO, and reads the most
recent positive purchase EVENT, matched on `company_item_id`.

### Line dispositions bind to approvals by fingerprint

Freezing dispositions at the first final decision blocked the owner's real
workflow: a Site Manager records the final review, and only then does the CEO
rule a line out of budget.

Each FINAL approval now records a `disposition_fingerprint` — a hash of the
exact purchasing set it decided on — and the gate completes only when both
responsibilities have approved the SAME, still-current set. A later exclusion
neither rewrites nor deletes the earlier approval; it simply means that
approval no longer satisfies the gate, and its author decides again on the new
set as a new immutable row (the FINAL slot uniqueness is widened by the
fingerprint). The generated IPO therefore always contains exactly the set the
formal authority actually approved. Dispositions freeze for real once the IPO
exists.

The backfill for this column has to lift `material_demand_approvals`'
append-only trigger for one statement. That is legitimate precisely because it
is the migration owner doing a one-time structural fill of a newly added
column — no decision content changes, and the guard is restored in the same
transaction.

A related subtlety worth recording: the first version of the fingerprint CHECK
was `disposition_fingerprint ~ '...'`, which evaluates to NULL for a NULL
value — and a CHECK constraint ACCEPTS NULL. The `IS NOT NULL` test in the
final constraint is load-bearing, not redundant.

### Reports bind to the exact authoritative Pricing version

Joining every SUBMITTED version duplicated a repriced Demand and presented a
rejected v1 alongside the approved v2 as though both were authoritative. The
Demand-history and traceability datasets now join the one version the IPO was
generated from, falling back to the latest submitted version only where no IPO
exists yet.

### Documents state only what is true

The IPO PDF no longer carries purchased quantity or current workflow status: a
document whose meaning drifts after issuance is not an authority. The Delivery
Challan PDF no longer asserts "received the above material in good order"
before any receipt has happened — it now carries the blank confirmation area
the authentic E-Set sample uses, and omits mutable workflow status.

### Other corrections

- Site coherence is enforced relationally: an IPO cannot claim a site other
  than its Demand's, a challan other than its IPO's, or a receipt other than
  its challan's.
- Completed handover and confirmation tuples freeze at the database level, as
  the original receiver already did.
- A cancellation reason routinely carries commercial context, so it is
  withheld from operational viewers and kept out of audit metadata and
  notification payloads; the category stays visible.
- Excel exports are bounded at 50,000 rows and refuse an oversized request with
  a message asking for narrower filters, rather than assembling an unbounded
  workbook in memory.

### WhatsApp — unchanged, and honestly described

The official WhatsApp Business Platform provider is unchanged and remains the
only kind that will ever ship. Its send uses `recipient_type: individual`,
which is what the Cloud API supports; the configuration and UI therefore say
"destination", never "group". Automatic delivery to a department WhatsApp
GROUP remains an external production-validation item: the architecture is in
place and the destination is configurable per department, but group delivery
depends on the provider and business account actually supporting that
destination, which cannot be verified from this codebase.

## Organization authority and capability bundles

`ADMIN` remains the stable internal role code, but every user-facing surface
labels it **Site Administrator**. Administration is an ordinary Department;
Department and Position rows have no relationship to application roles or
permissions. An Administration employee in a Team Lead position receives no
authority until Governance explicitly assigns an application role.

Procurement is an application function, not a Department or role. Governance
stores named bundle assignment provenance separately from individual
permission overrides. `PROCUREMENT_STAFF` grants the minimum operational set
(`demand.view`, `procurement.site_scope`, pricing, purchasing, IPO view, and
Delivery Challan view/manage), excluding `demand.approve` and `ipo.cancel`.
`FORMAL_APPROVER` grants only `demand.approve` and stays separate.

`procurement.site_scope` is the explicit site-wide record scope. Price
visibility remains field visibility only and never widens scope. Effective
permission precedence is role + explicit GRANT + active bundle, then explicit
DENY; removing a bundle deletes only its assignment and therefore preserves
unrelated grants and role permissions. Every assignment/removal is confirmed,
transactional, and append-only-audited.

## 2026-08-30 — Runtime Provisioning Is Part of Database Release and Readiness

**Decision:** A managed database release is one fail-closed operation:
migrations, runtime role/RLS convergence, and an actual runtime-connection
verification. `npm run db:release` is the authoritative entry point. The API
does not run migrations at process startup and never receives the migration
credential.

**Reason:** A deployment reached all 38 migration ledger entries while the
post-migration provisioning step had not been rerun for the capability-bundle
and fleet tables. The schema check correctly described the schema but could not
describe whether `esdms_runtime` could serve it; login and `/me` therefore
failed with PostgreSQL `42501` despite `schemaCompatible=true`.

**Consequences:** Provisioning now writes a narrow reviewed-version marker and
verifies every runtime-accessible table's RLS policy dynamically. Readiness
requires that marker and the negative privilege boundary as well as schema
compatibility, and production additionally proves the active connection is
`esdms_runtime`. The runtime verifier executes the exact shared profile query,
so a missing grant on any login/profile dependency fails before cutover. A new
migration that adds an application table must update the explicit grants; it
cannot become ready merely by advancing `pgmigrations`.
