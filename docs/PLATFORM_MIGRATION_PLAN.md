# Platform migration plan

**Status: plan only. Only Phase 0 (this document and the architecture
contract) is done.** Architecture and invariants:
[PLATFORM_DATABASE_ARCHITECTURE.md](./PLATFORM_DATABASE_ARCHITECTURE.md).

Starting point (real current state):
- The company ESDMS Supabase/PostgreSQL project **already exists** and ESDMS
  is **already deployed** on it. No new project is created and ESDMS is not
  re-launched. The target is that existing project plus two new isolated
  schemas, `permit` and `attendance`.
- Canonical repositories: ESDMS `/Users/ashar/Projects/eset-digital-management-system`
  (`53b129f`); Permit `~/Desktop/E-SET/DMS/e-set-digital-permit-system`;
  Attendance `~/Desktop/E-SET/DMS/eset-attendance`. The Desktop ESDMS
  recovery copy is backup only.

Rules for every phase:
- Small, reviewable change in one repository at a time; its own commit/PR.
- Preconditions checked; test gates (architecture §19) green; security
  invariants (architecture §18) re-verified.
- Phases 2–8 run only on local or disposable databases. Production is
  touched first in Phase 9.
- Backup before any step that touches a shared or production database.
  Source environments (old Permit project, Attendance SQLite) stay intact
  and are never deleted during this programme.
- Each phase ends at a named **stop/rollback point**; the next phase starts
  only after the previous gate passed.
- No secrets, password hashes or connection strings in logs, docs, chat or
  Git.

## Phase 0 — Architecture contract

Baselines of the three repositories, local test runs in scratch copies,
collision inventory, the two platform documents.
- **Rollback point:** revert the documentation commit. No system touched.

## Phase 1 — Freeze baselines, full backups, read-only inventory

- Record approved commits of all three repositories.
- Full backups: existing ESDMS project (confirm Supabase backup/PITR and take
  a logical `pg_dump` as the ESDMS operator), ESDMS storage objects, old
  Permit project database and its storage, a copy of the live
  `attendance.db` (sensitive data).
- **Read-only** inventory of the existing ESDMS deployment: Supabase plan and
  backup settings, PostgreSQL version, roles, schemas, exposed Data API
  schemas, extensions, migration level/readiness, connection limits; Render
  services and their (names-only) environment variables.
- Restore the ESDMS dump into an isolated database once to prove the backup.
- **Stop point:** nothing was changed; inventory reviewed. If any backup or
  restore fails, stop here.

## Phase 2 — Permit namespace/schema foundation (local/disposable)

In the Permit repository:
1. Migration runner: ledger `permit.schema_migrations`; platform migration
   lock; connects as `permit_migrator`.
2. Role provisioning: `permit_migrator`, `permit_runtime` (**NOBYPASSRLS**),
   `permit_privileged` only where required; `search_path = pg_catalog,
   permit, pg_temp` (SECURITY DEFINER functions: `pg_catalog, pg_temp`
   with every object schema-qualified); revokes for
   `PUBLIC`/`anon`/`authenticated`/`service_role`.
3. Verified final-state baseline (0038) schema-qualified into `permit`,
   explicit per-table policies `TO permit_runtime`, SECURITY DEFINER
   `search_path` re-pinned.
4. Runtime verify script (grants, RLS, ownership, no BYPASSRLS, isolation).
5. Schema-diff check against a fresh 0001–0038 replay.
- **Gate:** Permit suites green on a disposable PostgreSQL; the existing
  `app_runtime` BYPASSRLS design is gone.
- **Rollback point:** revert the Permit branch. Nothing deployed.

## Phase 3 — Permit-owned authentication (local/disposable)

1. `permit.users` (UUID PK = preserved Supabase user id, normalized unique
   email, Argon2id, `session_version`, timestamps); every `auth.users` FK
   re-pointed to `permit.users(id)`. No use of ESDMS `public.users`.
2. Backend login/logout/session/change-password with an HttpOnly cookie
   session, rate limiting, CSRF protection; `app_user_access` stays the
   account-state boundary.
3. Account admin and Permit CEO bootstrap write `permit.users`.
4. Frontend: Supabase Auth client and its `VITE_SUPABASE_*` auth variables
   removed.
5. Legacy-hash verify + transparent Argon2id upgrade code, used only if
   Phase 6 confirms a safely verifiable scheme.
- **Gate:** all Permit suites and E2E green; no Supabase Auth API usage left.
- **Rollback point:** revert the Permit branch. Nothing deployed.

## Phase 4 — Attendance PostgreSQL adapter/schema (local/disposable)

1. `attendance` schema, own ledger, `attendance_migrator` /
   `attendance_runtime`.
2. Direct translation of the current SQLite schema; one append-only raw event
   table with unique `event_key`, `timestamptz`, preserved raw
   timestamp/input fields, indexes; no partitioning.
3. Backend storage adapter `node:sqlite` → `pg`. The K-50 agent API contract
   (`x-attendance-agent-key`, request/response shapes) and the local
   frontend/reporting/export flow are unchanged. No human user auth is added.
- **Gate:** Attendance suites green; event-key parity and idempotent re-post
  tests green.
- **Rollback point:** revert the Attendance branch; the SQLite app keeps
  running.

## Phase 5 — Disposable integrated rehearsal environment

One disposable PostgreSQL representing the target: ESDMS `public` restored
from the Phase 1 dump (current migration level), plus `permit` and
`attendance` created by their own runners and role scripts.
- **Gate:** ESDMS readiness unchanged; all three verify scripts and the
  cross-schema isolation tests green.
- **Stop point:** discard the environment.

## Phase 6 — Migrate a COPY of Permit data

1. On the old Permit project, read-only: aggregate hash-prefix check
   (architecture §9); no hash printed. **If the scheme is not safely
   verifiable: STOP and obtain approval for a controlled password-reset
   plan.**
2. Import a copy of Permit data and users (preserved UUIDs) into the rehearsal
   `permit` schema; copy storage objects to a rehearsal bucket.
3. Verify row counts/checksums, legacy login + Argon2id upgrade, document
   downloads, Permit suites against the rehearsal.
- **Stop point:** discard rehearsal data; source untouched.

## Phase 7 — Migrate a COPY of Attendance SQLite data

1. Import the Phase 1 `attendance.db` copy into the rehearsal `attendance`
   schema.
2. Verify row counts, identical `event_key` set, identical daily report and
   Excel export for reference months; agent re-post of known events is
   deduplicated.
- **Stop point:** discard rehearsal data; SQLite source untouched.

## Phase 8 — Full three-application security/regression rehearsal

All three applications run against the rehearsal database with their own
runtime roles: full suites, E2E, isolation tests (each role denied the other
schemas; `anon`/`authenticated`/`service_role` denied `permit`/`attendance`),
smoke tests, a timed dry run of the Phase 9–11 runbook.
- **Gate:** written go/no-go for production.
- **Stop point:** discard the rehearsal; production untouched.

## Phase 9 — Back up production ESDMS project and create the new schemas

1. Fresh ESDMS backup + logical dump; ESDMS readiness recorded.
2. Create roles and empty `permit`/`attendance` schemas via their runners;
   confirm neither schema is in the Data API exposed schemas.
3. Re-check ESDMS readiness and ESDMS smoke test.
- **Rollback point:** drop the empty `permit`/`attendance` schemas and their
  roles. ESDMS data untouched.

## Phase 10 — Permit production migration/cut-over

1. Freeze; backup; old Permit API in maintenance/read-only.
2. Import data and users; copy objects; verify (Phase 6 checklist).
3. Deploy Permit (new auth) pointing at the shared project; smoke test.
- **Point of no return:** first user write on the new environment. Before
  it: switch back to the old Permit project (intact). After it: roll
  forward, or restore the old project and reconcile new writes manually.

## Phase 11 — Attendance production migration/cut-over

1. Backup; final `attendance.db` copy; stop writes briefly.
2. Import; parity check (Phase 7 checklist).
3. Switch the Attendance backend to PostgreSQL; the agent keeps calling the
   same authenticated HTTP API; confirm new punches arrive with no
   duplicates.
- **Rollback point:** switch the backend back to the untouched SQLite
  persistence; events sent meanwhile are re-posted and deduplicated by
  `event_key`.

## Phase 12 — Acceptance/observation period

Monitor all three applications (errors, connection usage, backups, agent
sync); repeat isolation checks; business owners sign off.
- **Rollback:** Phase 10/11 rollback paths remain available because sources
  are kept intact.

## Phase 13 — Retirement (explicit approval only)

Retire the old Permit database/Supabase Auth and the old Attendance SQLite
persistence only after explicit written approval and the agreed retention
period, with final archived dumps kept.

## Open blockers

1. A copy of the live company-PC `attendance.db` (Phase 1/7).
2. Permit E2E needs `npx playwright install chromium` on the test machine.
3. Supabase Auth hash scheme to be confirmed at Phase 6 (aggregate only).
4. Permit repository remote is on a personal account; move to company
   ownership before production phases.
5. ESDMS `service_role` exposure on `public` — separate ESDMS assessment.
6. Remote human access to Attendance needs its own auth design before any
   exposure beyond the current trusted/local boundary.
7. Permit document generation's bucket readiness check reads Supabase
   `storage.buckets`, which Permit roles cannot (and will not) access in the
   shared database. Before the Permit cut-over, replace it with a check
   through Permit's S3/storage interface (architecture §12).
