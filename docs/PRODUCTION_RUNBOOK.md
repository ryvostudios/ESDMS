# Production runbook

Operator procedure for the first company production deployment and later
releases. Configuration details live in
[PRODUCTION_ENVIRONMENT.md](./PRODUCTION_ENVIRONMENT.md); the tick-list is
[GO_LIVE_CHECKLIST.md](./GO_LIVE_CHECKLIST.md). **Nothing here has been
executed yet.** Restore has **not** been verified on production-like
infrastructure; do not treat it as verified until it has been done.

## 1. Deployment sequence (first go-live)

The database release must succeed before the API serves traffic, and the CEO
can be created as soon as the database exists; otherwise the order is:

1. **Ownership.** Confirm company access to GitHub `E-SET-DIGITAL/esdms`, a
   company Supabase organization, a company Render workspace, and the DNS for
   the chosen domain. No personal accounts.
2. **Supabase project.** Create a new dedicated ESDMS project (not the Digital
   Permit System project), choose region and a production plan with backups.
3. **Secrets.** Record the database owner password, a new
   `ESDMS_RUNTIME_PASSWORD`, `JWT_SECRET`, and the service-role key in the
   company password manager.
4. **Operator access.** On a trusted operator machine: clone the approved
   commit, `cd backend && npm ci`, install the `psql` client, and set
   `MIGRATION_DATABASE_URL`, `DATABASE_URL` (as `esdms_runtime`) and
   `ESDMS_RUNTIME_PASSWORD` privately (not in shell history or files in Git).
5. **Release the database:** `npm run db:release`.
6. **Verify 47 migrations** — the release output and later readiness report
   `expectedMigrationCount` = `appliedMigrationCount` = 47.
7. **Verify the restricted runtime role** — `db:release` step 3 must pass
   (grants, RLS, ownership, functions, provisioning marker, login query).
8. **Storage.** Create the private bucket (e.g. `esdms-private`).
9. **Render backend.** Create the web service with the variables in
   PRODUCTION_ENVIRONMENT.md §3 (runtime `DATABASE_URL` only; no migration
   credentials). Custom domain `api.<company-domain>`.
10. **Deploy backend** (approved commit, manual deploy).
11. `GET https://api.<company-domain>/api/v1/health` → `ok`.
12. `GET .../api/v1/health/ready` → `ready`, `schemaCompatible` and
    `runtimeProvisioningCompatible` true, 47/47, no `problems`.
13. **Frontend.** Create the static site (`VITE_API_URL` = frontend origin +
    `/api/v1`, `/api/v1/*` rewrite, SPA fallback); deploy.
14. **DNS.** Point `app.` and `api.` at the Render services; wait for TLS.
15. **Verify HTTPS/cookies/CORS.** Readiness through the frontend proxy
    (`https://app.<domain>/api/v1/health/ready`); a login sets
    `esdms_session` as `Secure; HttpOnly; SameSite=Lax`; no CORS errors.
16. **Create the protected CEO** with `npm run user:create-ceo`
    (PRODUCTION_ENVIRONMENT.md §7). Can be done any time after step 7.
17. **CEO first login;** change password if a temporary one was handed over.
18. **Organization and branding** in CMS (issuer name decision, logo,
    departments to deactivate, contact line).
19. **Real users** through Employees → login, roles and bundles.
20. **Smoke test** (section 3).
21. **Backup and restore verification** (section 2).
22. **Accept production** (sign-off).
23. **Only afterwards** retire legacy/QA environments (section 5).

## 2. Backup and restore

**Before every important release, reset or data correction:**

- Database: check that a recent Supabase backup exists for the project (the
  backup schedule/retention and point-in-time recovery depend on the plan and
  add-ons — confirm in the project's Backups page). For a release-specific
  restore point, also take a logical backup as the owner:
  `pg_dump --format=custom` using `MIGRATION_DATABASE_URL` from the operator
  machine; store it encrypted in company storage.
- Files: Supabase database backups **do not include Storage objects**. Copy
  the private bucket's objects to company-controlled storage for the same
  point in time.
- Record the Git commit deployed with that backup (application and schema must
  match).

**Restore procedure:**

1. Stop writers: suspend the API service (and its outbox worker) so no new
   writes arrive.
2. Restore the database from the Supabase backup/PITR, or `pg_restore` the
   logical dump into a fresh, empty database.
3. Re-run `npm run db:release` against the restored database (idempotent;
   re-converges `esdms_runtime` grants/RLS/provisioning marker).
4. Restore bucket objects for the same point in time.
5. Deploy the Git commit that matches the restored schema (migration level).
6. Verify `/health`, `/health/ready` (47/47), CEO login, one document download.

**Restore verification:** perform the steps above into an **isolated**
database and bucket before go-live and record the date and result. Until that
is done, restore is unverified.

## 3. Production smoke test (short)

Use one controlled smoke-test employee/user and clearly named test records.

- **Auth:** CEO signs in; password change works (`/change-password`); CEO shows
  no role/deactivate/override controls in Users & Access.
- **System:** `/api/v1/health` ok; `/api/v1/health/ready` ready, 47/47; CMS
  areas open for CEO; Audit Center shows the setup actions.
- **Workforce:** create one employee and a login; first login forces a
  password change; the user sees only their permitted areas.
- **Demand → Procurement:** one small Demand through review, approval,
  pricing, final approval, IPO, purchase, Delivery Challan and receiving.
- **Gate:** one Gate Pass approved, exit and return by a Gate Keeper, with
  odometer readings.
- **Documents:** the IPO/Delivery Challan/Gate Pass PDFs show the configured
  branding; an authorized user can download; a user without access cannot.
- **Storage:** a newly written file lands in the Supabase bucket; an
  unauthorized request for it is denied.

Afterwards, remove or archive the smoke-test data only through
repository-supported means and the approved handover policy (the operational
reset tool is **not** for production use; see OPERATIONS.md). If the policy is
to keep them, label them clearly as smoke tests.

## 4. Rollback

- **Application:** redeploy the previous approved commit in Render (manual
  deploy of that commit) for the backend and/or frontend.
- **Database:** **do not run down migrations** (several are forward-only by
  design). Recover data by restoring a verified backup (section 2).
- **Compatibility:** the application checks the migration level at readiness.
  Only roll the application back to a commit whose expected migration matches
  the database; if a release applied new migrations, rolling back the
  application alone leaves readiness not-ready — restore the matching database
  backup instead, or roll forward with a fix.

## 5. Legacy / non-production environments

These are **demo/QA only and are not production**. Do not modify or retire
them until production is accepted; then clean them up separately:

- Render `esdms-api-test` and `esdms-app-test` (personal account, older
  commit, 38 migrations).
- Supabase project `esdms-demo` (personal organization).
- The local "cloud-live" QA environment, including its personal Dropbox
  connection and QA files (see PRE_HANDOVER_AUDIT.md and the QA cleanup list).

The Digital Permit System is a separate application and project; it is not
part of any ESDMS environment.
