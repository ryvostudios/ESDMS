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

Inventory is a future module.

It may eventually manage company stock and material-related workflows according to approved business requirements.

Inventory must remain separate from Gate Pass.

In particular, Gate Pass must not become responsible for material receiving or stock verification merely because a vehicle carries materials.

Inventory implementation must not begin until:

1. Gate Pass MVP is stable,
2. Gate Pass regression tests exist,
3. the required Gate Pass/security review has been completed,
4. shared interfaces required by Inventory have been identified.

Current status:

**Planned — not implemented**

---

## 5. Procurement

Procurement is a future module.

Gate Pass and Procurement may interact through defined interfaces where required, but they remain separate business concerns.

Procurement pricing and sensitive procurement information must not become visible to Guard users through Gate Pass.

Current status:

**Planned — not implemented**

---

## 6. Material Receiving

Material receiving is separate from Gate Pass verification.

Material/item verification is not a Guard responsibility.

Receiving workflows may involve authorized roles such as Admin, Site Manager and/or Team Lead according to the eventual approved Inventory/receiving specification.

Current status:

**Planned — not implemented**

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
Inventory
        ↓
Additional Modules
```

This sequence may change only through an explicit documented project
decision. Workforce was inserted ahead of Inventory on 2026-08-23 — see
`docs/DECISIONS.md`.

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
| Inventory | Not started (per §14 sequencing) |
| Procurement | Not started |
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
