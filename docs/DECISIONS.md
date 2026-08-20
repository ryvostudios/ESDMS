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
