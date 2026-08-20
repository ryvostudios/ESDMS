# E-Set Digital Management System
## Architecture

## 1. System Purpose

The E-Set Digital Management System is a modular internal operational management platform.

It is not a single-purpose Gate Pass application.

Gate Pass is the first operational module.

Future modules may include:

- Inventory
- Procurement
- Material Receiving
- Material Issue / Usage / Return
- Fleet
- Maintenance
- WTG Operations
- E-BOP Operations
- Civil
- HSE
- Workforce / Attendance
- Notifications
- Reporting
- Management Dashboard
- Documents
- other future internal workflows

Modules must be introduced incrementally.

Gate Pass must reach a stable MVP before Inventory development begins.

---

## 2. High-Level Architecture

The intended architecture is:

```text
React PWA
    |
    | HTTPS REST API
    v
Node.js + Express
    |
    v
PostgreSQL
```

The frontend must never connect directly to PostgreSQL.

The Express backend is the trusted application layer.

---

## 3. Frontend

Technology:

- React
- Vite
- Progressive Web App (PWA)

Conceptual structure:

```text
frontend/
└── src/
    ├── app/
    ├── core/
    ├── shared/
    └── modules/
        └── gate-pass/
```

The frontend is responsible for:

- user interface,
- forms,
- local UI state,
- authorized data presentation,
- calling backend APIs,
- responsive/mobile experience,
- future PWA/offline behavior.

The frontend is an untrusted client for security purposes.

Frontend controls may improve user experience but must never be treated as authoritative security enforcement.

API communication must be centralized rather than duplicated throughout React components.

---

## 4. Backend

Technology:

- Node.js
- Express
- REST API

Versioned API base:

```text
/api/v1
```

The backend is responsible for:

- authentication,
- authorization,
- business logic,
- backend validation,
- database access,
- secure state transitions,
- server-generated timestamps,
- secure identifier/token generation,
- audit logging,
- file access authorization,
- sensitive configuration.

Preferred request flow:

```text
Route
  ↓
Middleware
  ↓
Controller
  ↓
Service
  ↓
Repository / Database Layer
  ↓
PostgreSQL
  ↓
Response
```

Large amounts of business logic must not be placed directly inside route definitions.

---

## 5. Database

Database:

**PostgreSQL**

PostgreSQL is required because the system needs:

- relational data,
- foreign keys,
- constraints,
- transactions,
- auditability,
- modular business records,
- strong data integrity,
- secure authorization patterns.

All schema changes must use migrations.

Manual undocumented production schema changes are prohibited.

The application should use a reputable database library, ORM or query builder that supports migrations.

The exact library will be selected before database implementation.

---

## 6. Shared Platform Layer

Shared functionality should not be independently reimplemented by every business module.

Potential shared systems include:

- authentication,
- authorization,
- users,
- departments,
- roles,
- permissions,
- notifications,
- audit logging,
- file/storage handling,
- centralized error handling,
- backend logging,
- API client,
- database configuration,
- validation helpers,
- reporting/export,
- email,
- security middleware,
- health checks.

Shared functionality must expose clear interfaces.

---

## 7. Business Modules

Business-specific logic belongs inside its module.

Examples:

```text
backend/src/modules/gate-pass/
frontend/src/modules/gate-pass/
```

Future modules may include:

```text
modules/inventory/
modules/procurement/
modules/maintenance/
```

A module must not directly manipulate another module's internal controller logic, React state or private database implementation.

Cross-module interaction should occur through defined services/interfaces.

---

## 8. Module Isolation

Module independence is a major architectural requirement.

After Gate Pass becomes stable, adding Inventory must not randomly break Gate Pass.

Protection mechanisms include:

- clear module boundaries,
- regression tests,
- shared interfaces,
- database migrations,
- clean Git checkpoints,
- focused changes,
- review of shared-code dependencies.

Before modifying shared functionality, determine which existing modules depend on it.

---

## 9. API Design

All application APIs should live under:

```text
/api/v1
```

Examples:

```text
/api/v1/health
/api/v1/auth
/api/v1/gate-passes
```

API communication from React must use a central API service.

Frontend environment configuration may contain public configuration such as:

```text
VITE_API_URL=
```

It must not contain backend secrets.

---

## 10. Data Flow and Trust Boundary

The browser is untrusted.

Authoritative flow:

```text
User
  ↓
React
  ↓
HTTPS
  ↓
Express authentication / authorization / validation
  ↓
Business logic
  ↓
PostgreSQL
```

React must not be allowed to authoritatively determine:

- user identity,
- roles,
- departments,
- permissions,
- ownership,
- approval authority,
- sensitive status transitions,
- server timestamps,
- access scope.

The backend validates those decisions.

---

## 11. PWA and Offline Architecture

The frontend is intended to become an installable PWA.

Offline operation may be required for site workflows, especially Gate Pass operations.

Offline functionality must not be implemented by indiscriminately caching authenticated APIs.

Future offline design must explicitly address:

- which data can be stored locally,
- action queues,
- idempotency,
- conflicts,
- authentication expiration,
- sync status,
- server reconciliation,
- evidence uploads,
- safe cleanup of local files.

The server remains authoritative after synchronization.

---

## 12. Development Sequence

Initial development sequence:

### Foundation

1. verify development tools,
2. initialize repository,
3. establish repository documentation,
4. scaffold React/Vite frontend,
5. scaffold Express backend,
6. implement `/api/v1/health`,
7. verify frontend-to-backend communication,
8. create first clean Git checkpoint.

### Platform

9. PostgreSQL connection,
10. migrations,
11. users,
12. authentication,
13. protected endpoint,
14. roles,
15. departments,
16. permissions,
17. authorization.

### First Business Module

18. Gate Pass.

Inventory must not begin before Gate Pass MVP stabilization and review.

---

## 13. Current Status

Current stage:

**Foundation**

The repository and development standards are being established.

No application business functionality is considered implemented yet.
