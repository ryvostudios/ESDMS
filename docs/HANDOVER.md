# ESDMS company handover guide

The short operator guide for taking over the E-Set Digital Management System.
It links to the authoritative documents instead of repeating them; where they
disagree, the linked document and the code win.

> **DO NOT RESET OR DEPLOY UNTIL THE TARGET ENVIRONMENT IS POSITIVELY
> IDENTIFIED.** The Render/Supabase handover target is currently
> **unresolved** (see [PRE_HANDOVER_AUDIT.md](./PRE_HANDOVER_AUDIT.md)).

## A. System overview

- **Frontend:** React + Vite progressive web app (`frontend/`).
- **Backend:** Node.js/Express REST API (`backend/`), all routes under
  `/api/v1`.
- **Database:** PostgreSQL (Supabase-compatible), schema managed only by
  `node-pg-migrate` migrations in `backend/migrations/`.
- **Shape:** a modular monolith — one API, one database, business modules
  (Workforce, Gate Pass, Material/Demand, Procurement, IPO, Delivery Challan,
  Receiving, CMS) with shared authorization, storage and notification layers.
- **Database identities:** the API connects as the restricted
  `esdms_runtime` role only (no ownership, no DDL, no `BYPASSRLS`). Migrations
  and role provisioning run separately with the schema-owner credential.
- **Release model:** `npm run db:release` (migrate → provision roles → verify
  runtime), then deploy backend, then frontend. See
  [DEPLOYMENT.md](./DEPLOYMENT.md) and [OPERATIONS.md](./OPERATIONS.md).

## B. Company authority model

- **Employee ≠ User.** An Employee is an HR record; a User is a login. An
  employee may have no login; a login is linked to an employee explicitly.
- **Department and Position grant no application authority.** A title such
  as "WTG Team Lead" or "Administration Team Lead" changes nothing on its own.
- **WHO may act** = application role + capability bundles + individual
  permission overrides.
- **WHERE they may act** = site / department scope, enforced by the backend.
- **An explicit DENY always wins** over role and bundle grants.

| Actor | What they do (default authority) |
| --- | --- |
| CEO | Company-wide power user; all System Administration areas; can grant, restrict and DENY others. The permanent original CEO cannot be demoted, deactivated or DENY-ed. |
| Site Manager / Upper Management | Site-wide operational visibility and Demand management review; no CMS or user governance unless the CEO delegates it, and then only within their own site and their own permissions. |
| HR | Employees, workforce configuration, documents, leave/rotation; creates and resets employee logins (which start as ordinary Employee). Cannot grant roles/capabilities or touch the CEO. |
| Team Lead | Own department: Demands, Gate Pass requests, receiving confirmation. Not company-wide. |
| Procurement Staff (bundle) | Pricing, purchasing, Delivery Challans and price visibility at its site. Cannot approve Demands or cancel IPOs. |
| Formal / Financial Approver (bundle) | Formal Demand approval with price visibility; kept separate from Procurement Staff. |
| Gate Keeper (role code `GATE_GUARD`) | Gate only: verify, exit, return, gate evidence. Never sees procurement prices. |
| Ordinary employee | Only what is explicitly granted (e.g. self-service, department receiving). |

Bundles and overrides are managed in **System Administration → Users & Access**.

## C. First company login

1. After the database release, create exactly **one** permanent original CEO
   with `npm run user:create-ceo` (hidden password prompt; no password in
   arguments, files or docs). Record its email as `ESDMS_ORIGINAL_CEO_EMAIL`.
2. Sign in as that CEO and confirm you reach the dashboard. The CEO account
   is not forced to change its password; the password entered at the prompt
   may be the CEO's long-term password (it can be changed any time at
   `/change-password`).
3. Verify CEO protection: in Users & Access the original CEO shows no role,
   deactivate or override controls.
4. Create employees in **Employees → Add Employee**, then give each the
   login they need from the employee page (logins start as Employee). Share
   the one-time temporary password securely; the user must change it.
5. Assign roles (Users & Access → Role) and capability bundles (Procurement
   Staff, Formal / Financial Approver) only to the people who need them.

Never create shared or generic admin accounts, and never reuse test accounts.

## D. System Administration (CMS)

| Area | Purpose | Kind |
| --- | --- | --- |
| Organization | Sites, departments, positions | Configuration |
| Users & Access | Roles, bundles, overrides, account status | Governance |
| Permission Catalog | Human-readable permission labels/help (never enforcement) | Configuration |
| Workforce Configuration | Employment types, profile sections, custom fields, document types, rotation, leave types | Configuration |
| Branding | Issuer name, contact line, logo on new documents | Configuration |
| Application Content | Sign-in text, dashboard announcement, support text (public) | Configuration |
| Integrations | Storage providers and safe integration status | Configuration |
| Audit Center | Governance and configuration history (who, target, when) | Oversight |
| System | Revision, migration level and readiness | Oversight |

Operational work (Demands, Procurement, IPOs, Delivery Challans, Receiving,
Gate Passes, employee records) happens in the main navigation, not in CMS.
Each area needs its own capability. See [CMS.md](./CMS.md).

**Logo:** upload a tightly cropped PNG/JPEG on a transparent or light
background, up to 2 MB. Branding affects **new** documents only; issued Gate
Pass, IPO and Delivery Challan PDFs keep their original bytes. Demand List PDFs
are regenerated from live data and use current branding.

## E. Storage

- Files are stored per object with the provider that wrote them (mixed
  providers). Existing files always stay on their original provider.
- Activating a provider in **Integrations** affects **future writes only**;
  nothing is migrated.
- Dropbox is the currently live-tested external provider. Google Drive live
  verification is deferred.
- Connect the **company** Dropbox account through CMS during handover.
  A personal/developer OAuth connection must never remain in the company
  environment.

Details: [CLOUD_STORAGE.md](./CLOUD_STORAGE.md).

## F. WhatsApp — DEFERRED POST-HANDOVER

The notification/outbox architecture and a simulated provider exist, but
production Meta WhatsApp Cloud API integration, message templates and webhooks
are **not** part of this handover. Keep WhatsApp disabled/simulated. In-app
notifications work independently.

## G. Attendance — DEFERRED POST-HANDOVER

Not implemented. A future integration will connect the existing local ZKTeco
K-50 attendance device through a secure outbound/local-agent design (no inbound
exposure of the office network).

## H. Digital Permit System

The Permit System is a **separate application** and is not integrated with
ESDMS. A future shared PostgreSQL/Supabase arrangement may be considered only
with separate schemas, runtime roles and migration identities.

## I. Deployment / release checklist

> **DO NOT RESET OR DEPLOY UNTIL THE TARGET ENVIRONMENT IS POSITIVELY
> IDENTIFIED.**

1. Verify a clean Git state at the approved revision.
2. Back up the target database (and file storage).
3. Verify the target environment identity (host, database, project owner).
4. Verify the permanent CEO account / preservation plan.
5. Run migrations (`npm run db:release` — never `migrate:up` alone).
6. Provisioning and security checks (part of `db:release`).
7. Verify the API uses the restricted `esdms_runtime` role.
8. `GET /api/v1/health` returns ok.
9. `GET /api/v1/health/ready` returns `ready` with no problems.
10. Smoke-test CEO sign-in.
11. Smoke-test critical workflows (Demand → IPO → Delivery Challan →
    Receiving; Gate Pass exit/return).
12. Verify storage (active provider, a document download).
13. Verify branding (logo and issuer name on a new document).
14. Verify no personal/test integrations or accounts remain.

Authoritative steps: [DEPLOYMENT.md](./DEPLOYMENT.md), [OPERATIONS.md](./OPERATIONS.md).

## J. Final reset checklist (conceptual)

**Preserve:** permanent CEO, roles, permissions, capability bundles, E-Set
organization structure, CMS configuration, branding, reference data,
migrations and database security objects.

**Remove:** QA users and employees, QA operational data, QA notifications and
audit rows (only if approved), test storage references, test provider objects,
personal OAuth integration records.

Actual target-specific counts **must be reviewed before execution** (the
reset tool's dry run produces them). See
[PRE_HANDOVER_AUDIT.md](./PRE_HANDOVER_AUDIT.md) and
[OPERATIONS.md](./OPERATIONS.md) "Safe local operational-data reset".

## K. Backup / restore

- A database backup/snapshot (and file backup) is required before any
  production deployment or reset, and its restore path must be known and
  tested.
- A destructive reset requires explicit human approval of the exact target.
- Use only the repository-supported reset tooling
  (`npm run reset:operational-data`, dry run first). Never a casual
  `TRUNCATE ... CASCADE` or ad hoc SQL.

## L. Operator troubleshooting

| Symptom | Safe check |
| --- | --- |
| Is the API up? | `GET /api/v1/health` → `{"status":"ok"}` |
| Can it serve? | `GET /api/v1/health/ready` → `ready`; otherwise read `problems` |
| Migration mismatch | Readiness shows expected vs applied migration; run the reviewed `db:release`, never edit the ledger |
| Integration disconnected | System Administration → Integrations shows safe status; reconnect the company account there |
| File download fails | Check the file's provider status in Integrations; files are never moved between providers automatically |
| User cannot access something | Users & Access → effective permissions; look for an explicit DENY (DENY wins) and check site/department scope |
| Who changed what? | Audit Center: filter by action/date; entries show actor, target and capability code |

Never paste credentials, connection strings or tokens into tickets or chat.

## Related documents

[PRODUCTION_ENVIRONMENT.md](./PRODUCTION_ENVIRONMENT.md) ·
[PRODUCTION_RUNBOOK.md](./PRODUCTION_RUNBOOK.md) ·
[GO_LIVE_CHECKLIST.md](./GO_LIVE_CHECKLIST.md) ·
[DEFERRED_WORK.md](./DEFERRED_WORK.md) ·
[SECURITY.md](./SECURITY.md) · [MULTIPART_SECURITY.md](./MULTIPART_SECURITY.md)
