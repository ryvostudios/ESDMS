# Platform go-live runbook: ESDMS + Digital Permit System + Attendance

**This is the authoritative procedure** for moving the three E-Set
applications onto the one company Supabase/PostgreSQL database:

| Schema | Application |
| --- | --- |
| `public` | ESDMS |
| `permit` | Digital Permit System |
| `attendance` | Attendance |

It supersedes the ordering in PLATFORM_MIGRATION_PLAN.md phases 9–13.
ESDMS-only operations stay in PRODUCTION_RUNBOOK.md.

**Status: rehearsed, not executed.** Every step below was rehearsed on
disposable local PostgreSQL 17 clusters with synthetic data (Phase 6,
`ops/platform-rehearsal/`). Nothing has been deployed, and no production
database, Supabase project, Dropbox account, DNS record, Render service or
K-50 device has been touched. The independent audit comes next. Do not start
this runbook before it is approved.

## 0. What is being released

| Application | Branch (feature, not merged) | Head at Phase 6 | Migrations |
| --- | --- | --- | --- |
| ESDMS | `feature/cms-web-pwa-branding` | `f89c11b` + Phase 6 commits on the branch | 48 (`public.pgmigrations`) |
| Permit | `feature/permit-storage-cms` | `c3acaa6` or later on the branch | 42 (`permit.schema_migrations`: baseline 0001–0038 + 0039–0042) |
| Attendance | `feature/postgres-attendance` | `20f1c62` or later on the branch | 2 (`attendance.schema_migrations`) |

Record the exact commits approved by the audit here before starting. The
application commit and the schema must always match (see §9).

**Tooling used below**

| Application | Tools |
| --- | --- |
| ESDMS | `npm run db:release` (migrate, provision `esdms_runtime`, verify), `npm run db:verify-runtime`, `npm run verify:deployment` |
| Permit | `database/roles/provision-permit-roles.sql`; `npm run migrate -- --baseline-without-reference-data`; `npm run data:import-standalone [-- --execute \| --verify]`; `npm run storage:migrate-legacy [-- --execute \| --verify]`; `npm run storage:rekey` |
| Attendance | `database/roles/provision-attendance-roles.sql`; `npm run db:migrate`; `npm run db:import-sqlite -- --sqlite <copy> [--execute \| --verify]`; `npm run agent-key:hash` |
| Platform (ESDMS `ops/platform-rehearsal/`) | `security-matrix.sql`, `security-definer-audit.sql`, `platform-fingerprint.sql`, `platform-rehearsal.sh` and `topology-check.sh` (disposable rehearsal only) |

**Rules that hold for every step**
- **Secrets.** Secrets come only from the company secret manager and are
  typed with `read -rs` into environment variables, never on command lines,
  in files, in chat or in Git. Unset them afterwards.
- **Admin URL.** `ADMIN_DATABASE_URL` is the Supabase `postgres` login, used
  only by the operator.
- **Migration URLs.** They must be **direct or session-pooler** URLs
  (advisory locks). Runtime URLs may use the transaction pooler.
- **Platform migration lock.** Only one application's migration or release
  runs at a time. ESDMS `db:release`, the Permit runner and import, and the
  Attendance runner and import all take the advisory lock `1163085140`
  with a non-blocking try. A second release fails fast with "Another E-Set
  platform migration or release holds the platform lock". Runtime code
  never takes it. The operator still runs steps strictly in order.
- **No down migrations**, no improvised `DELETE`/`TRUNCATE`, and no
  production use of the ESDMS operational-reset tool.
- **Sources stay intact.** The old Permit database and storage, and the
  Attendance SQLite file, are never modified or deleted during this runbook
  (§42).

## Domains, cookies and CORS (required topology)

This topology is derived from the code (Phase 6 §19). It was verified
locally with both real backends under company-style hostnames
(`ops/platform-rehearsal/topology-check.sh`: 18 checks passed).

| | ESDMS | Permit |
| --- | --- | --- |
| Frontend | `https://app.eset.pk` (static site, `/api/v1/*` rewrite to the API) | `https://permit.eset.pk` (static site, `/api/v1/*` rewrite to the API): *proposed name* |
| API | `https://api.eset.pk` | `https://permit-api.eset.pk`: *proposed name* |
| Browser API base | `VITE_API_URL=https://app.eset.pk/api/v1` | `VITE_API_BASE_URL` empty (same-origin `/api/v1`) |
| CORS allowlist | `FRONTEND_ORIGIN=https://app.eset.pk` | `CORS_ALLOWED_ORIGINS=https://permit.eset.pk` |
| Session cookie | `esdms_session`: HttpOnly, SameSite=Lax, Secure in production, `Path=/`, **host-only** | `permit_session`: HttpOnly, SameSite=Lax, Secure in production, `Path=/api/v1`, **host-only** |
| Dropbox OAuth origin | `CLOUD_STORAGE_OAUTH_ORIGIN=https://app.eset.pk` | `DROPBOX_OAUTH_ORIGIN=https://permit.eset.pk` |
| Dropbox redirect URI | `https://app.eset.pk/api/v1/cms/cloud-storage/dropbox/callback` | `https://permit.eset.pk/api/v1/cms/dropbox/callback` |
| Proxy trust | `TRUST_PROXY_HOPS` (PRODUCTION_ENVIRONMENT.md) | `TRUST_PROXY_CIDRS` (Permit DEPLOYMENT.md "Network topology") |

**Why this topology**
- **The Lax cookie must be same-site.** Each session cookie is SameSite=Lax,
  so every API call must be same-site with the page. The same-origin
  `/api/v1` rewrite is the simplest form of that.
- **The OAuth callback must share the cookie's host.** The Dropbox
  callback is a top-level navigation that must carry the session cookie, so
  its origin must be the host that holds the cookie, which is the frontend
  host with the rewrite.

**Hard rules**
- **`COOKIE_DOMAIN` must stay unset for ESDMS.** A `Domain=eset.pk` cookie
  would send the ESDMS session token to every `*.eset.pk` host, including
  Permit's servers.
- **The two applications never share a host.** Their cookies are
  host-only and differently named. Each API refuses the other's token even
  under its own cookie name (verified). Credentialed CORS answers only the
  application's own frontend. Permit refuses cookie-authenticated mutations
  without an allowlisted Origin or Referer.
- **Attendance has no DNS name and is never published.** Its human UI and
  read API have no login and run only on the Attendance PC, bound to
  loopback. Startup fails on any other bind address, and non-loopback Host
  headers are refused (Attendance `docs/LOCAL_ONLY.md`). It reaches the
  database outbound over verified TLS only.
- **The Permit names are proposals.** DNS is not changed by this programme
  until the company approves the names. The ESDMS names are already in
  PRODUCTION_ENVIRONMENT.md.

## Pre-cutover

1. **Maintenance and change freeze.**
   - Announce the window.
   - Freeze merges and deploys on all three applications.
   - Put the old Permit application into maintenance (read-only).
   - Agree who may stop the K-50 agent on the Attendance PC.
2. **Record deployed state.** For each application, record:
   - the running commit and the migration ledger (count and latest name);
   - environment variable **names** (never values);
   - Render service settings and Dropbox app settings.
3. **Full database backup (company project).**
   - Confirm a recent Supabase backup or point-in-time recovery exists.
   - Take a logical backup as the administrator:
     `pg_dump --format=custom -f platform-full.dump "$ADMIN_DATABASE_URL"`.
   - Store it encrypted in company storage and record its SHA-256.
4. **Per-schema backups.**
   - Run `pg_dump --format=custom -n public` (and later `-n permit`,
     `-n attendance`).
   - Capture the roles, without passwords:
     `pg_dumpall --roles-only --no-role-passwords` where the plan allows.
     Otherwise record `SELECT rolname, rolsuper, rolbypassrls, rolinherit
     FROM pg_roles` and the memberships.
   - Capture **database-level settings**. `pg_dump` does not carry them (a
     finding of the rehearsal):
     `SELECT format('ALTER DATABASE %I SET %s TO %s;', …) FROM
     pg_db_role_setting WHERE setrole = 0 …`, using the statement in
     `platform-rehearsal.sh` step 11.
5. **ESDMS storage backup.** Supabase backups do not include Storage
   objects. Copy the ESDMS private bucket (or the ESDMS Dropbox folder) to
   company storage for the same point in time.
6. **Permit source storage backup.** Copy the old Permit project's
   `issued-permit-documents` bucket, and take a full `pg_dump` of the old
   Permit database. Record hashes.
7. **Attendance SQLite backup.** On the Attendance PC:
   - Stop the backend (`start-backend-hidden.ps1` process) and the agent.
   - Copy `backend/data/attendance.db`, plus any `-wal`/`-shm` files, to two
     company locations and record the SHA-256.
   - Never open the original with a tool. The import reads a private copy.
8. **Restore verification before cutover.** Restore steps 3–7 into an
   **isolated** project or cluster, as rehearsed:
   1. Restore the roles.
   2. Apply the database settings.
   3. `pg_restore`.
   4. Re-provision the passwords.
   5. Run the matching releases.
   6. Compare `platform-fingerprint.sql`.

   Record the date and result. **Until this is done, restore is
   unverified and cutover must not start.**
9. **Production preflight / read-only inventory.**
   - Run `ops/platform-rehearsal/platform-fingerprint.sql` and
     `security-definer-audit.sql` against production as the administrator.
     They are read-only; save the output.
   - Run `security-matrix.sql` for `anon` and `authenticated` (with
     `own=none`) and for `service_role` (with `own=none -v
     report_only=public`). This is **read-only**: every probe runs in a
     rolled-back transaction, so save the output.
   - Confirm schemas `permit` and `attendance` do **not** exist yet, and are
     not in the Supabase Data API exposed schemas.
10. **Real Permit auth inspection, without printing hashes.** On the old
    Permit project, run only:
    - aggregate hash-format prefix counts:
      `SELECT substring(encrypted_password from '^\$[A-Za-z0-9]{1,10}\$(\d{2}\$)?') AS prefix, count(*) FROM auth.users GROUP BY 1`;
    - users with no password or no email: count only;
    - normalized-email collisions: count only.

    Only `$2a$`/`$2b$`/`$2y$` with cost 04–16 are importable. Anything else
    blocks the Permit import until a controlled-reset decision is made
    (`--allow-accounts-without-password` covers missing passwords only).

## Database

11. **Platform migration lock.** From here until step 18, only the
    operator's migration commands run. Each takes the platform lock itself.
    If one reports the lock is held, stop and find the other process; never
    work around it.
12. **ESDMS release.** Run
    `MIGRATION_DATABASE_URL=… DATABASE_URL=… ESDMS_RUNTIME_PASSWORD=… npm run db:release`
    from the approved ESDMS commit. Expect 48/48 migrations, provisioning,
    and "Database release complete". Then run `npm run db:verify-runtime`.
13. **Provision Permit.**
    1. Set `PERMIT_MIGRATOR_PASSWORD`, `PERMIT_RUNTIME_PASSWORD` and
       `PERMIT_PRIVILEGED_PASSWORD` (`read -rs`).
    2. Run `psql --no-psqlrc "$ADMIN_DATABASE_URL" -f database/roles/provision-permit-roles.sql`.
       On Supabase, the administrator may need `SET` membership in
       `permit_migrator` to create the schema with that owner (Permit
       SHARED_DATABASE.md open item). Grant it for this step only, then
       revoke it.
    3. Run `npm run migrate -- --baseline-without-reference-data` as
       `permit_migrator`. Expect 42 migrations and **no reference rows**:
       the history brings its own.
14. **Migrate Permit identity and data.** From the approved Permit commit,
    with `STANDALONE_DATABASE_URL` set to a login on the old project that
    can read every row:
    - The source login needs BYPASSRLS or table ownership.
    - The tool sets `row_security = off`, so a login that RLS would filter
      fails instead of importing nothing. This was a real finding of the
      rehearsal.

    Run in order:
    1. `npm run data:import-standalone`: a dry run that must report no
       problems, all tables matching, identities N/N, the 20 identity
       relationships, sequences, and plausible permit/JSA ranges.
    2. `npm run data:import-standalone -- --execute`: one transaction,
       verified before commit.
    3. `npm run data:import-standalone -- --verify`.

    Save each JSON report. It holds counts, digests and ids only.
15. **Verify Permit reconciliation.**
    - Compare the source and target counts in the report with the
      preflight counts.
    - Spot-check 3 permits, one of each state (issued, closed/renewed,
      held or cancelled), by permit number and UUID in both databases.
    - Sign in as one migrated user. The bcrypt hash is upgraded to Argon2id
      on the first success.
    - Confirm `permit_runtime` sees the permits.
16. **Provision Attendance.** Set `ATTENDANCE_MIGRATOR_PASSWORD` and
    `ATTENDANCE_RUNTIME_PASSWORD`, then run
    `psql --no-psqlrc "$ADMIN_DATABASE_URL" -f database/roles/provision-attendance-roles.sql`
    and `npm run db:migrate` (expect "2 known, 2 applied now").
17. **Import the Attendance SQLite copy.** On an operator machine, using the
    **copy** from step 7:
    1. `npm run db:import-sqlite -- --sqlite <copy>`: a dry run. It must
       report no problems or mismatches, and an identical daily report for
       every business date.
    2. `npm run db:import-sqlite -- --sqlite <copy> --execute`.
    3. `npm run db:import-sqlite -- --sqlite <copy> --verify`.

    Any `occurred_at` that is not the agent's `+05:00` format stops the copy
    (strict agent contract, `docs/K50_AGENT_CONTRACT.md`).
18. **Verify Attendance reconciliation.**
    - Source vs target counts, event-key digest and settings.
    - Shift workers must be exactly the source's.
    - Id sequences continue after SQLite's AUTOINCREMENT high-water mark.
    - The copy's hash is unchanged.

## Storage

19. **Configure Permit Dropbox.**
    - Use a company-owned **App Folder** app.
    - Set `DROPBOX_CLIENT_ID`, `DROPBOX_CLIENT_SECRET`,
      `DROPBOX_OAUTH_ORIGIN`, `PERMIT_STORAGE_MASTER_KEY` and
      `PERMIT_STORAGE_KEY_VERSION`.
    - The CEO connects through the Permit CMS. Only the CEO may do this.
20. **Migrate Permit files.** With the legacy S3 variables still set:
    1. `npm run storage:migrate-legacy`: a dry run; every job must be
       `would_copy`.
    2. `npm run storage:migrate-legacy -- --execute`.
    3. Re-run until nothing is examined. It is resumable and idempotent.
21. **Verify file hashes and readback.**
    - `npm run storage:migrate-legacy -- --verify` must report `mismatched: []`.
    - Download 3 issued PDFs through Permit; each must match its job hash.
    - The legacy bucket stays untouched.
22. **Configure CMS branding** in both CMSs: organization name, logos and
    PWA icon. Issued documents keep their frozen branding. Browsers may keep
    installed-PWA icons until reinstall (documented limitation).

## Applications

23. **Deploy ESDMS** (backend, then frontend) at the approved commit, with
    `COOKIE_DOMAIN` unset.
24. **ESDMS readiness.**
    - `/api/v1/health` and `/api/v1/health/ready` (48/48).
    - `npm run verify:deployment -- https://api.eset.pk` with the smoke
      account.
25. **Deploy the Permit backend** at the approved commit.
    - Set `DATABASE_URL` (`permit_runtime`) and `PRIVILEGED_DATABASE_URL`
      (`permit_privileged`), with `DB_SSL=true` and `DB_CA_CERT_PATH`.
    - Set `CORS_ALLOWED_ORIGINS`, `SITE_TIMEZONE`, `TRUST_PROXY_CIDRS`, the
      storage variables and the Dropbox variables.
    - No Supabase Auth variables (removed).
26. **Permit readiness.** `/health` and `/ready`. Readiness is
    database-only by design: sign-in never depends on Dropbox.
27. **Deploy the Permit frontend** with `VITE_API_BASE_URL` empty and the
    `/api/v1/*` rewrite.
28. **Auth, CMS and PDF smoke.**
    - A migrated user and the CEO sign in.
    - The cookie is host-only, and `/auth/me` works.
    - The CEO opens the CMS, and `storage:rekey` (a dry run) shows no
      missing key versions.
    - Issue one clearly labelled smoke permit; its PDF generates, downloads
      and carries the branding.
29. **Start Attendance in the approved local topology.** On the Attendance
    PC, set:
    - `ATTENDANCE_DB_PROVIDER=postgres` and `ATTENDANCE_DATABASE_URL`
      (`attendance_runtime`);
    - `ATTENDANCE_DB_SSL=verify` and `ATTENDANCE_DB_SSL_CA_FILE` (the
      Supabase CA);
    - `ATTENDANCE_AGENT_KEY_SHA256`;
    - `ATTENDANCE_HOST` unset (127.0.0.1).

    Start the backend. `/api/ready` must return 200.
30. **K-50 sync smoke.** Start `auto_sync.py`. The first run re-sends the
    whole device log in 2,000-event chunks; all known events are
    duplicates, and only punches newer than the SQLite copy are inserted.
    Make one test punch on the device, and see it arrive once, with
    re-sends deduplicated.
31. **Verify reports.** Today's report and one past day match the old
    SQLite report for the same day, and the Excel export opens.

## Acceptance

32. **Database isolation check.** Re-run `security-matrix.sql`:
    - as `esdms_runtime`, `permit_runtime`, `permit_privileged` and
      `attendance_runtime` (real logins);
    - as the API roles via `SET ROLE`.

    Also re-run `security-definer-audit.sql`. Everything must pass. The only
    reported (not failed) item is the ESDMS `service_role` access on
    `public` (§ Known items).
33. **CEO/admin acceptance** in each application.
34. **Permit workflow smoke:** draft → submit → CRO → HSE → issue → PDF,
    then close, on clearly labelled smoke records.
35. **Attendance smoke:** live punches, today's report and the export.
36. **Document/download checks:** ESDMS IPO, Delivery Challan and Gate Pass
    PDFs; Permit issued PDFs (both migrated and new). An unauthorized user
    is refused.
37. **CMS/PWA checks:**
    - Branding, manifest, favicon and app icon, with the new versioned URLs.
    - Bundled fallback when storage is offline. Verified locally: sign-in
      and the public manifests work with no CMS branding and no storage.
38. **Backup after a successful cutover:** a full and per-schema dump,
    storage copies, and a recorded point-in-time position.
39. **Observation period:**
    - Watch errors, connection counts (the Attendance runtime limit is 10;
      the Permit and ESDMS pool sizes are in their docs), backups and agent
      sync.
    - Repeat step 32 weekly.
    - The business owners sign off.

## Retirement

40. **Do NOT delete the old Permit database, Supabase Auth users or
    storage** at cutover.
41. **Do NOT delete the Attendance SQLite file** or its backups.
42. **Retire only after explicit written approval** and the agreed
    retention period, with final archived dumps kept.

## Rollback runbook

**Principles**
- Stop writes first.
- Revert the **application** commit when the database is compatible.
  Otherwise **restore** a verified backup.
- Keep the source systems running or restorable.
- Never improvise `DELETE`/`TRUNCATE`, and never run down migrations.

**Application rollback (rehearsed, step 15 of the rehearsal)**
- **Rehearsed cases:**
  - A previous build keeps working after a later, expand-only migration.
  - Attendance readiness now tolerates newer ledger rows, but refuses
    edited or missing ones.
  - The old runner refuses to migrate an unknown ledger, which is correct:
    rollback never migrates.
  - The previous Permit (`2f22e53`) and ESDMS (`f89c11b`) builds run
    against the Phase 6 database.
- **Constraints:**
  - Migrations must be expand-only (additive, nullable or defaulted) so the
    previous build stays compatible.
  - A contract (destructive) change ships only after the previous build is
    retired.
  - **Attendance builds before Phase 6** (`6dfcdaf`) predate
    rollback-tolerant readiness and report not-ready on a database carrying
    migration 0002. Never roll Attendance back past Phase 6 on PostgreSQL.
    Before cutover, the rollback is the untouched SQLite persistence.
  - **Permit storage key rotation:** a build older than `b7e6ad8` reads one
    key version only. Do not rotate the storage key until that build is
    outside the rollback window.

| Trigger | Response |
| --- | --- |
| ESDMS deployment fails (readiness not 48/48, smoke fails) | Stop the ESDMS API. Redeploy the previously recorded ESDMS commit (same 48 migrations). If `db:release` itself failed mid-way, it is idempotent: fix and re-run, or restore the step-3 backup of `public` into an isolated copy and investigate. Permit and Attendance are unaffected. |
| Permit auth fails after cutover | Before the first user write on the new Permit: put Permit into maintenance and point users back at the old Permit project, which is intact and still on Supabase Auth. After first writes: roll forward (fix and redeploy), or restore the old project and reconcile the new writes manually (point of no return). |
| Permit data mismatch (the import report is not clean) | The import never commits a mismatch. Stay on the old Permit. For a mismatch found after commit: stop the Permit API, restore the pre-import `permit` schema backup (step 4 dump taken after step 13, or the step-3 full backup) into an isolated copy, compare, then either re-import into a freshly provisioned empty `permit` schema (drop and re-create only the schema, never `public`/`attendance`) or stay on the old Permit. |
| Dropbox migration mismatch (`--verify` reports mismatched) | The job's download already fails closed. Keep the legacy bucket. Re-upload the object from the legacy bucket or Dropbox version history after the investigation. Nothing on the database side changes. |
| Attendance report mismatch | Switch the Attendance backend back to `ATTENDANCE_DB_PROVIDER=sqlite` on the untouched SQLite file. Punches sent meanwhile are re-sent by the agent from the device log and deduplicated by `event_key`. Investigate on the PostgreSQL copy. |
| K-50 sync failure | The agent stops at the failed chunk; earlier chunks are committed and the next run re-sends everything idempotently. Check the backend readiness, database reachability (TLS/CA), the agent key hash and the rate limit (240/min). If not resolvable, switch back to SQLite as above. The device log is never cleared. |
| Cross-schema privilege leak (the matrix or audit fails) | **Stop the affected application's writes immediately.** Revoke the leaked privilege with a reviewed statement from the owning application's provisioning, re-run the matrix, and investigate how it appeared. No application may run with a failed matrix. |
| Readiness failure (any application) | Do not route traffic. Read the readiness reason (ESDMS: migration level, provisioning; Attendance: ledger, database; Permit: database). Fix configuration or roll the application back per its row above. |

## Known items carried into production (not blockers of the rehearsal)

These are reported by the rehearsal, owned by ESDMS, and accepted by
nothing yet. The audit decides on them.

- **ESDMS `service_role` on `public`.** Supabase's default privileges grant
  `service_role` all privileges on objects the owner creates in `public`,
  and ESDMS provisioning revokes `anon`/`authenticated` but not
  `service_role`. The rehearsal counted 242 allowed operations and EXECUTE
  on `esdms_schema_migration_state`. `service_role` has **no** privilege in
  `permit` or `attendance` (proven). The service-role key must stay
  server-only and `public` should not be exposed through the Data API. See
  DEFERRED_WORK.md.
- **ESDMS `esdms_schema_migration_state(text)`** pins
  `search_path = pg_catalog, public` without `pg_temp`. It is not
  exploitable: the body references only `public.pgmigrations`, qualified.
  Add `pg_temp` last in a future expand migration (DEFERRED_WORK.md).
- **The ESDMS migration owner** in the rehearsal has CREATEROLE, as the
  Supabase `postgres` login does in production. It is an operator
  credential, never a runtime one.

## Rehearsal evidence (Phase 6)

`ops/platform-rehearsal/platform-rehearsal.sh` runs on three brand-new
disposable clusters (platform, recovery, and the old standalone Permit). It
builds the whole platform in the order above and proves:
- the 48 + 42 + 2 migrations;
- the Permit import: 5/5 identities, all 20 identity relationships,
  191 history rows and 7 sequences;
- the Attendance import: 48,944 events, 125 report dates, and an unchanged
  source;
- platform-lock serialization of all five migration/import tools;
- the security matrix for 11 roles (the API roles impersonated), and the
  SECURITY DEFINER audit;
- a full backup/restore into a separate cluster: 112 tables and 3,739
  catalog/data lines identical, Attendance reports identical, and Permit
  document hashes intact;
- per-schema restores;
- application rollback.

See `ops/platform-rehearsal/README.md` for how to run it.
