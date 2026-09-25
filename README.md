# E-Set Digital Management System

Internal digital management platform for E-Set.

## Project Goal

Build a secure, modular and maintainable company management system that replaces selected paper-based operational workflows with controlled digital processes.

The platform is being designed so that individual business modules can be developed and maintained without unnecessarily affecting other modules.

## Development Status

Gate Pass, Workforce / Employee Management, Procurement & Material Receiving
V1 (Checkpoints 1-8) and Fleet (Driver/Vehicle master data) are implemented
end-to-end (backend, frontend, private storage, PWA, migrations, and tests).
Workforce includes transactional XLSX import, a practical XLSX report catalog,
bounded private-file ZIP export, HR operations, CEO/UM governance, and
employee self-service. See `docs/DECISIONS.md` for the security boundaries
and current deferred scope, and `docs/OPERATIONS.md` for the ordered release
procedure.

**Handover documents:** [`docs/HANDOVER.md`](docs/HANDOVER.md) (start here),
[`docs/CLOUD_STORAGE.md`](docs/CLOUD_STORAGE.md),
[`docs/PRE_HANDOVER_AUDIT.md`](docs/PRE_HANDOVER_AUDIT.md),
[`docs/MULTIPART_SECURITY.md`](docs/MULTIPART_SECURITY.md) and
[`docs/DEFERRED_WORK.md`](docs/DEFERRED_WORK.md). Production deployment:
[`docs/PRODUCTION_ENVIRONMENT.md`](docs/PRODUCTION_ENVIRONMENT.md),
[`docs/PRODUCTION_RUNBOOK.md`](docs/PRODUCTION_RUNBOOK.md) and
[`docs/GO_LIVE_CHECKLIST.md`](docs/GO_LIVE_CHECKLIST.md).

No production deployment exists yet: deployment is explicitly gated on
independent re-review of the fix passes. See `docs/ARCHITECTURE.md` §13 and
`docs/MODULES.md` §15 for current per-module status. Three things in
particular are implemented but **not yet externally verified**, and this
codebase should not be described as "production-ready" until they are:

- **Render deployment topology**: the app requires the frontend and API to
  be deployed same-site (e.g. `app.<domain>` / `api.<domain>`) — separate
  default `*.onrender.com` service domains are not a supported topology
  for authenticated use (the session cookie won't be sent cross-site). See
  `docs/SECURITY.md` §5.2.
- **Supabase Storage**: the provider implementation exists and is unit
  tested against a mocked API, but no real Supabase project has been
  connected — live bucket privacy, connectivity, and TLS behavior remain
  to be verified during actual deployment. See `docs/SECURITY.md` §9.
- **WhatsApp delivery**: only a simulated (demo) provider is connected. A
  real Meta integration will need to implement the reconciliation
  behavior this codebase is already designed around (an uncertain/crashed
  send is never blindly retried — see `docs/SECURITY.md` §11) before it
  can be trusted for real driver notifications.

## Initial Module

The first operational module is:

**Gate Pass**

The Gate Pass module manages controlled vehicle and driver movement into
and out of company sites — request/approval workflow, guard exit/return
verification via QR, PDF generation, and WhatsApp delivery to the driver
(demo provider; no real WhatsApp credentials configured).

Full Inventory development (stock ledger/balances) must not begin until
the Gate Pass MVP has reached a stable, reviewed checkpoint and
Procurement & Material Receiving V1 has been adopted — see
`docs/PROCUREMENT_RECEIVING_SPEC.md` and `docs/DECISIONS.md` for the V1
scope. Checkpoints 1-8 are implemented: Department Material Catalog →
Demand → Initial Approval → Procurement Pricing (with previous actual-price
comparison) → Final Approval with line-level budget disposition →
automatically generated IPO → purchasing → Delivery Challan → Receiving
(including Admin fallback custody and department confirmation) → Completed
history, plus Demand/IPO/Delivery Challan PDFs, permission-aware Excel
exports and official WhatsApp document delivery.

Full Inventory is deliberately NOT implemented: there is no stock balance,
stock ledger, FIFO/batch consumption, Material Issue, usage, return, stock
adjustment or transfer. Receiving records what physically arrived; the
system does not state what is in stock today.

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
│   ├── GATE_PASS_SPEC.md
│   └── PROCUREMENT_RECEIVING_SPEC.md
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

Tests: `npm test` in each of `backend/` and `frontend/`. Backend tests create,
migrate and drop a freshly named local disposable database by default; use
`npm run test:provided` only for an explicitly supplied safely named test DB. See
`backend/scripts/provision-db-roles.sql` and `docs/SECURITY.md` §8 before
ever pointing this at a production database.

## Database Release

Managed environments use the single post-review release command documented in
`docs/DEPLOYMENT.md`:

```bash
cd backend
npm run db:release
```

It requires separate migration-owner and `esdms_runtime` credentials, applies
migrations, converges the checked-in least-privilege grants/RLS policies, and
verifies the real runtime serving contract. A current migration ledger alone
is not deployment readiness. The running API receives only `DATABASE_URL` for
`esdms_runtime`; it must never receive `MIGRATION_DATABASE_URL` or
`ESDMS_RUNTIME_PASSWORD`.
