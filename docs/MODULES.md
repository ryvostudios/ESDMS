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

Workforce and attendance functionality may be introduced as a future module according to separately approved business requirements.

It must not be coupled directly into Gate Pass internals.

Current status:

**Planned — not implemented**

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
Inventory
        ↓
Additional Modules
```

This sequence may change only through an explicit documented project decision.

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
| Workforce / Attendance | Not started |

See `docs/DECISIONS.md` for the specific decisions behind the Gate Pass
implementation and its subsequent security fix pass.
