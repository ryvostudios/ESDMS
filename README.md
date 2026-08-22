# E-Set Digital Management System

Internal digital management platform for E-Set.

## Project Goal

Build a secure, modular and maintainable company management system that replaces selected paper-based operational workflows with controlled digital processes.

The platform is being designed so that individual business modules can be developed and maintained without unnecessarily affecting other modules.

## Development Status

Gate Pass MVP implemented end-to-end (backend, frontend, PWA, tests) and
subsequently hardened through an independent security/architecture review
and fix pass — see `docs/DECISIONS.md` for what changed and why.

No production deployment exists yet: deployment is explicitly gated on
independent re-review of the fix pass. See `docs/ARCHITECTURE.md` §13 and
`docs/MODULES.md` §15 for current per-module status.

## Initial Module

The first operational module is:

**Gate Pass**

The Gate Pass module manages controlled vehicle and driver movement into
and out of company sites — request/approval workflow, guard exit/return
verification via QR, PDF generation, and WhatsApp delivery to the driver
(demo provider; no real WhatsApp credentials configured).

Inventory development must not begin until the Gate Pass MVP has reached a
stable, reviewed checkpoint.

## Technology

### Frontend
- React
- Vite
- Progressive Web App (PWA)
- Vitest + Testing Library for tests

### Backend
- Node.js
- Express
- Versioned REST API under `/api/v1`
- node:test for tests

### Database
- PostgreSQL, via `node-pg-migrate`

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
```

## Getting Started

Backend (`backend/`):

```bash
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, FRONTEND_ORIGIN
npm install
npm run migrate:up
npm run dev
```

Frontend (`frontend/`):

```bash
cp .env.example .env   # set VITE_API_URL
npm install
npm run dev
```

Tests: `npm test` in each of `backend/` and `frontend/`. See
`backend/scripts/provision-db-roles.sql` and `docs/SECURITY.md` §8 before
ever pointing this at a production database.