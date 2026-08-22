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
