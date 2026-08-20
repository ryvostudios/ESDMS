# E-Set Digital Management System

Internal digital management platform for E-Set.

## Project Goal

Build a secure, modular and maintainable company management system that replaces selected paper-based operational workflows with controlled digital processes.

The platform is being designed so that individual business modules can be developed and maintained without unnecessarily affecting other modules.

## Development Status

Early development / project foundation.

The application architecture and development environment are currently being established.

No production deployment exists yet.

## Initial Module

The first operational module will be:

**Gate Pass**

The Gate Pass module will manage controlled vehicle and driver movement into and out of company sites.

Inventory development must not begin until the Gate Pass MVP has reached a stable checkpoint.

## Planned Technology

### Frontend
- React
- Vite
- Progressive Web App (PWA)

### Backend
- Node.js
- Express
- Versioned REST API under `/api/v1`

### Database
- PostgreSQL

The database will be introduced after the initial frontend/backend foundation has been verified.

## Core Engineering Priorities

Development decisions should prioritize:

1. Security
2. Data integrity
3. Authorization and isolation
4. Maintainability
5. Module independence
6. Auditability
7. Reliability
8. Testing
9. Simple user experience
10. Development speed

Development speed must not come at the expense of security or data integrity.

## Repository Structure

```text
eset-digital-management-system/
├── frontend/
├── backend/
├── docs/
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   ├── MODULES.md
│   ├── DECISIONS.md
│   └── GATE_PASS_SPEC.md
├── AGENTS.md
├── README.md
└── .gitignore