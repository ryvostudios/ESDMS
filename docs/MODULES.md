# E-Set Digital Management System
## Modules

## 1. Purpose

This document tracks the business modules of the E-Set Digital Management System and their current implementation status.

A module must not be marked as implemented merely because it has been discussed, designed, documented or represented by a prototype.

Use clear status descriptions such as:

- Planned
- Specification in progress
- Scaffolded
- Implementation in progress
- Implemented
- Tested
- Stable MVP

---

## 2. Shared Platform

The Shared Platform is not a business module.

It provides common capabilities used by business modules.

Planned shared capabilities include:

- authentication,
- users,
- roles,
- departments,
- permissions,
- authorization,
- audit logging,
- notifications,
- file/evidence storage,
- reporting/export,
- centralized API handling,
- validation,
- error handling,
- backend logging,
- database access,
- security middleware,
- health monitoring.

Current status:

**Implemented**

Authentication (cookie session + revocation), users/roles/departments/sites,
authorization, audit logging, notification outbox (in-app + WhatsApp,
site-scoped), file/evidence storage (local + Supabase-ready), and security
middleware are implemented and used by Gate Pass. Reporting/export remains
unstarted.

---

## 3. Gate Pass

Purpose:

Digitize and control company vehicle and driver movement while preserving the required operational Gate Pass workflow.

Gate Pass is the first business module.

Planned capabilities include:

- create Gate Pass,
- save draft,
- submit for approval,
- approve,
- reject,
- cancel where permitted,
- secure verification,
- driver and vehicle association,
- vehicle exit,
- departure odometer,
- departure evidence/photo,
- Vehicle Outside state,
- vehicle return,
- return odometer,
- return evidence/photo,
- server-side distance calculation,
- completed history,
- search and filtering,
- audit history,
- appropriate exports,
- future offline gate operation.

Core lifecycle:

```text
DRAFT
  ↓
PENDING_APPROVAL
  ↓
APPROVED
  ↓
VEHICLE_OUTSIDE
  ↓
COMPLETED
```

Additional terminal/alternate states include:

```text
REJECTED
CANCELLED
```

Sensitive state transitions must be performed by explicit backend operations.

The frontend must not be allowed to arbitrarily assign authoritative workflow states.

Detailed business rules belong in:

`docs/GATE_PASS_SPEC.md`

Current status:

**Implemented, security-hardened (two independent review/fix passes); not
yet deployed**

Full lifecycle (create → approve → guard exit/return → complete), PDF/QR
generation, WhatsApp delivery (demo provider), evidence photos, audit log,
and PWA are implemented end-to-end. See `docs/DECISIONS.md` for what the two
review passes changed and why, and §15 below for the summary table.

---

## 4. Inventory

Full Inventory (stock ledger, current balances, FIFO/batch consumption,
Material Issue/Usage/Return, adjustment, transfer, warehouse/bin
management) remains a future module, deliberately deferred behind
Procurement & Material Receiving V1 — see `docs/DECISIONS.md`'s "V1 Scope
Narrowed to Procurement & Material Receiving" entry. It will be introduced
only after an authoritative physical opening-stock count establishes a
cutover point, once departments have adopted the digital Demand +
Receiving workflow below.

Inventory must remain separate from Gate Pass.

In particular, Gate Pass must not become responsible for material receiving or stock verification merely because a vehicle carries materials.

Full Inventory implementation must not begin until:

1. Gate Pass MVP is stable,
2. Gate Pass regression tests exist,
3. the required Gate Pass/security review has been completed,
4. shared interfaces required by Inventory have been identified.

All four are satisfied: Gate Pass and Workforce have each completed
implementation and independent security review (§15 below), and
`docs/PROCUREMENT_RECEIVING_SPEC.md` — built for Procurement & Material
Receiving V1 — identifies the shared Company Item / Department Material
Catalog interfaces a future Inventory module would build on.

Current status:

**Planned — not implemented.** (The Company Item / Department Material
Catalog foundation it will eventually build on is implemented as part of
Procurement & Material Receiving V1 — see §5.)

---

## 5. Procurement & Material Receiving (V1)

Procurement and Material Receiving are being digitized together as one
scoped V1, per explicit owner instruction — see
`docs/PROCUREMENT_RECEIVING_SPEC.md` for the full authoritative
specification and `docs/DECISIONS.md` for why the scope was narrowed from
the broader Inventory design explored in Phase I.

V1 covers: Department Material Catalog → Demand List → UM/CFO review →
Procurement pricing → final approval → an auto-generated IPO → purchasing
→ Delivery Challan → material receiving → department confirmation/closure.
It explicitly does **not** include a stock balance, stock ledger, or any
of the other Inventory concerns listed in §4.

Gate Pass and Procurement/Receiving may interact through defined
interfaces where required (e.g. a future optional reference from a
Receiving record to the Gate Pass that physically carried the material),
but they remain separate business concerns and separate records — Gate
Pass and Delivery Challan stay separate (see `docs/DECISIONS.md`).

Procurement pricing and other sensitive procurement/financial information
must not become visible to Guard users through Gate Pass, and financial
visibility within Procurement/Receiving itself is capability-controlled
(see `docs/PROCUREMENT_RECEIVING_SPEC.md` §16/§28) — a user authorized to
see operational quantities is not automatically authorized to see prices.

Current status:

**Checkpoints 1-2 implemented.** Checkpoint 1 (Material Catalog Foundation)
— Company Item, Department Material Catalog, and Units of Measure —
backend module `backend/src/modules/material-catalog/`, frontend module
`frontend/src/modules/material-catalog/`, migration
`1787412000000_material-catalog-foundation.js`. Checkpoint 2 (Department
Demand List Foundation) — Draft creation from the department's own
catalog, edit, and the `submit` transition into `PENDING_INITIAL_REVIEW`
with a first-review notification — backend module
`backend/src/modules/material-demand/`, frontend module
`frontend/src/modules/material-demand/`, migration
`1787413000000_material-demand-foundation.js`. Initial UM/CFO review
through Closure (checkpoints 3-8) are specified in
`docs/PROCUREMENT_RECEIVING_SPEC.md` but **not implemented**.

---

## 6. Material Receiving

Material receiving is part of the Procurement & Material Receiving V1
scope above (§5) — see `docs/PROCUREMENT_RECEIVING_SPEC.md` §19-§24 for
the full authoritative specification (department-member receiving, the
Admin fallback-custodian path, and the explicit "no Inventory balance in
V1" rule).

Material receiving is separate from Gate Pass verification. Material/item
verification is not a Guard responsibility, and receiving does not depend
on the Gate Guard.

Receiving involves the relevant department's own staff first, with Admin
as a temporary fallback custodian only when nobody from the relevant
department is available on site — not Admin, Site Manager, or Team Lead
as universal receivers.

Current status:

**Planned — not implemented** (part of Procurement & Material Receiving
V1's checkpoint 7; see §5's status).

---

## 7. Fleet

Fleet-related functionality may eventually provide controlled vehicle master data and related operational information.

Gate Pass may reference approved vehicle records through a defined interface rather than owning all fleet functionality.

Current status:

**Planned — not implemented**

---

## 8. Maintenance

Maintenance is a future module.

Current status:

**Planned — not implemented**

---

## 9. HSE

HSE is a future module.

Current status:

**Planned — not implemented**

---

## 10. Workforce / Attendance

Gate Pass is now a stable, protected existing module. Workforce/Employee
Management is the current active development target, per explicit
instruction, with Inventory deferred until after it.

Planned governance model: CEO (highest application authority, terminal-only
bootstrap, no self-promotion by anyone else) → Upper Management (broad
access, individually restrictable by CEO) → HR (employee administration,
not automatically salary/financial access) → Employee (self-service
profile). Effective permissions = role permissions + individual grants −
individual denials, with explicit denial always winning.

It must not be coupled directly into Gate Pass internals.

Current status:

**Core module implemented, security-hardened; not yet deployed.** Built on
the governance foundation (`CEO`/`UPPER_MANAGEMENT`/`HR`/`EMPLOYEE` roles,
effective permissions, `governance_audit_log`) — see `docs/DECISIONS.md`
("Workforce Module Begun...", "Governance / User-Management Foundation",
"Workforce / Employee Management Module"). Implemented:

- Employee Master (`src/modules/employees/`) — independent of login
  (`user_id` nullable/unique), Employee ID assigned by HR, duplicate
  detection (warns, not hard-blocks), status lifecycle with linked-login
  coordination, cycle-checked reporting-manager chain.
- Departments (extended, not duplicated — same table Gate Pass already
  uses), Positions, Employment Types — all archive-not-delete, in-use
  guards before archiving.
- Effective-dated employment assignments (site/department/position/
  employment-type/rotation-policy/reporting-manager) — transfers create new
  history, never overwrite; a same-date correction upserts in place.
- Onboarding: HR-created logins are role-`EMPLOYEE` by construction (no
  role parameter exists in that code path at all); forced first-login
  password change (`must_change_password`, enforced in
  `requirePermission` for permission-gated routes and a standalone
  `requirePasswordChanged` middleware for self-service routes); HR-reset
  invalidates the prior session.
- Self-service profile (`src/modules/profile/`) — personal details behind
  an explicit field allowlist, emergency contacts, HR-configurable profile
  sections/custom fields (`src/modules/workforce-config/`, reserved-key
  denylist, field-type immutable once a value exists), profile photo
  (versioned, signature-validated), profile-completion percentage.
- Employee documents (`src/modules/documents/`) — versioned (never
  overwritten), configurable document types, verification workflow,
  expiry, document-requests as a pending action feeding in-app
  notifications.
- Compensation (`src/modules/compensation/`) — confidential, effective-dated
  ledger; self-viewable without special permission, never self-changeable
  by any actor including CEO; never overwritten.
- Employment contracts (`src/modules/contracts/`) — DRAFT editable,
  everything else DB-trigger-immutable (content and delete), including
  against CEO and a direct SQL session; amendments reference a finalized
  original; contract access permissions are separate from ordinary HR
  access.
- Rotation (`src/modules/rotation/`) — configurable policies, signed-ledger
  balance, no auto-expiry, manual adjustments audited.
- Leave (`src/modules/leave/`) — configurable types, explicit
  submit/approve/reject/cancel state transitions only, no self-decision
  even with `leave.approve` granted.
- CEO-only business-history logical removal, with password re-confirmation
  and a protected forensic audit trail (`governance_audit_log`, widened
  rather than duplicated).
- Transactional Employee XLSX import: a scoped template, ZIP-expansion/file/
  row limits, formula rejection, complete preview validation, signed
  actor-and-file-bound confirmation, duplicate warnings, all-or-nothing
  writes, and protected audit.
- Nineteen practical XLSX reports (`src/modules/reports/`) with independent
  domain permission gates, site scoping, formula-injection–safe cells,
  confidential compensation/contract variants, and protected audit.
- Bounded streaming ZIP export containing `Data.xlsx`,
  `Documents_Index.xlsx`, authorized latest documents/profile photos and,
  only with separate contract permissions, finalized contracts. ZIP paths
  and filenames are server-generated; each stored file is checksum-verified.
- Functional Workforce dashboard, employee directory/detail/assignment,
  HR configuration and operations queues, reports/import/export, CEO/UM
  governance, forced-password-change, and Employee self-service for profile,
  photo, custom fields, emergency contacts, documents, leave, rotation,
  finalized contracts, and own compensation.

Deliberately deferred: advanced temporary/short-term assignment scheduling
(schema only), probation tracking, rehire/employment-period modeling,
Attendance integration, payroll/budget, a general correction-request
workflow beyond document requests, saved report/table preferences,
background export jobs beyond the explicitly bounded synchronous V1, and
cross-module search. Inventory / Procurement remains a separate future
module.

An external pre-pilot audit (2026-08-23) reviewed this module for
site-pilot readiness. The highest-priority security/data-integrity/
authorization findings were fixed in that same session — see the
"Pre-Pilot Security & Data-Integrity Hardening Pass" entry in
`docs/DECISIONS.md` for exactly what changed. **The frontend for this
module is functional, not polished or fully complete**: Governance/User-
Management, full Employee administration, Documents/Contracts lifecycle
UI, and Workforce configuration remain largely API-only or minimal-UI
surfaces exercised mainly by the backend test suite; mobile/responsive
layout, the visual design system, accessibility fixes, PWA offline-state
handling, and a rebuilt operational dashboard were not addressed in that
session and remain open work before a controlled site pilot.

---

## 11. Other Future Modules

Potential future areas may include:

- WTG Operations,
- E-BOP Operations,
- Civil,
- reporting,
- management dashboards,
- documents,
- notifications,
- other approved internal workflows.

Listing a module here does not authorize implementation.

Business requirements must be defined before implementation begins.

---

## 12. Module Boundary Rule

Business-specific code should normally live under:

```text
backend/src/modules/<module>/
frontend/src/modules/<module>/
```

Modules should communicate through defined contracts or shared services.

A module must not directly manipulate another module's:

- internal controllers,
- private service implementation,
- React state,
- internal UI state,
- private database implementation.

Shared code should be introduced only when functionality is genuinely shared.

---

## 13. Shared-Code Change Rule

Before changing shared functionality, determine:

1. which modules depend on it,
2. whether its public behavior changes,
3. whether regression tests are required,
4. whether documentation must change,
5. whether a database migration is involved,
6. whether the change affects a security boundary.

Do not modify shared infrastructure casually to solve one module-specific problem.

---

## 14. Current Development Order

Current order:

```text
Platform Foundation
        ↓
Authentication
        ↓
Authorization
        ↓
Gate Pass
        ↓
Gate Pass Stabilization
        ↓
Security / Regression Review
        ↓
Workforce / Employee Management
        ↓
Procurement & Material Receiving V1
        ↓
Full Inventory
        ↓
Additional Modules
```

This sequence may change only through an explicit documented project
decision. Workforce was inserted ahead of Inventory on 2026-08-23; the
full Inventory module was further split into "Procurement & Material
Receiving V1" (in progress) followed by full Inventory (stock ledger and
everything that depends on it) on 2026-08-25 — see `docs/DECISIONS.md`.

---

## 15. Current Status Summary

| Area | Status |
|---|---|
| Repository foundation | Established |
| Frontend | Implemented (React/Vite, PWA) |
| Backend | Implemented (Node/Express, `/api/v1`) |
| PostgreSQL integration | Implemented (node-pg-migrate) |
| Authentication | Implemented — HttpOnly cookie session (browser) + Bearer (non-browser clients), with `session_version`-based revocation |
| Authorization | Implemented — RBAC, department/site scope |
| Gate Pass | Implemented, security-hardened; not yet deployed |
| Procurement & Material Receiving V1 | Checkpoint 1 (Material Catalog Foundation) implemented; checkpoints 2-8 (Demand → Closure) not started — see `docs/PROCUREMENT_RECEIVING_SPEC.md` |
| Inventory (full — stock ledger/balances) | Not started; deferred behind Procurement & Material Receiving V1 adoption (per §14 sequencing) |
| Fleet | Not started |
| Maintenance | Not started |
| HSE | Not started |
| Workforce / Employee Management | Core module implemented, security-hardened; not yet deployed. Attendance itself remains out of scope. |

See `docs/DECISIONS.md` for the specific decisions behind the Gate Pass
implementation and its subsequent security fix passes.

"Security-hardened" above describes the code and its test coverage, not a
verified deployment: the Render same-site domain topology, a real
Supabase Storage project, and a real Meta WhatsApp integration are all
designed for but not yet exercised against anything real — see
`docs/SECURITY.md` §5.2, §9, §11 and `README.md`.
