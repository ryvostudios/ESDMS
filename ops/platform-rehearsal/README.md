# Platform rehearsal (disposable clusters only)

Tools that rehearse and check the shared E-Set database: ESDMS in `public`,
Permit in `permit`, Attendance in `attendance`. The go-live procedure they
rehearse is [docs/PLATFORM_GO_LIVE_RUNBOOK.md](../../docs/PLATFORM_GO_LIVE_RUNBOOK.md).

| File | Purpose | Safe against production? |
| --- | --- | --- |
| `platform-rehearsal.sh` | builds the whole platform in the production order and proves every Phase 6 gate (below) | **No** (refuses a non-localhost `PGHOST`) |
| `topology-check.sh` | the real ESDMS and Permit backends side by side under company-style hostnames: cookies, CORS, Origin, OAuth callback, CMS/PWA fallbacks | **No** (rotates runtime passwords in the disposable cluster) |
| `security-matrix.sql` | cross-application denial matrix for one role (real login, or `SET ROLE` for a NOLOGIN API role) | Yes: every probe runs in a rolled-back transaction |
| `security-definer-audit.sql` | SECURITY DEFINER / search_path / EXECUTE / dynamic-SQL audit | Yes: read-only |
| `platform-fingerprint.sql` | catalog and data fingerprint for backup/restore comparison | Yes: read-only (reads every table) |

## Running the full rehearsal

**Clusters.** Create three empty throwaway PostgreSQL 17 clusters on
localhost, with one superuser in a passfile:
- *platform*;
- *recovery*, which must stay empty;
- *standalone*, holding the synthetic OLD Permit database. It is separate
  because its BYPASSRLS reader must never exist beside the platform.

**Checkouts.**
- A clean ESDMS backend export (`git archive <commit> backend | tar -x` +
  `npm ci`, no `.env`).
- The Permit and Attendance checkouts with `node_modules`.

```bash
PLATFORM_REHEARSAL_DISPOSABLE_CLUSTER=yes PGHOST=localhost PGUSER=postgres PGPASSFILE=<passfile> \
PGPORT=<platform> RECOVERY_PGPORT=<recovery> STANDALONE_PGPORT=<standalone> \
ESDMS_BACKEND=<export>/backend ESDMS_REPO=<esdms checkout> \
PERMIT_REPO=<permit checkout> ATTENDANCE_REPO=<attendance checkout> \
ROLLBACK_ESDMS_COMMIT=f89c11b ROLLBACK_PERMIT_COMMIT=2f22e53 ROLLBACK_ATTENDANCE_OLD_COMMIT=6dfcdaf \
REHEARSAL_REPORT_DIR=<empty dir> \
  ops/platform-rehearsal/platform-rehearsal.sh
```

**Steps** (each fails the run on any deviation):
1. ESDMS `db:release` on a fresh database, under the Supabase platform state
   and Supabase's default privileges.
2. An ESDMS business sample, created through ESDMS's CEO bootstrap.
3. Permit roles, and the baseline without reference data plus 0039–0042.
4. A synthetic OLD standalone Permit database: the 0001–0038 replay plus
   `auth.users` with bcrypt fixtures, history from the real services
   covering all 20 identity relationships, and legacy document objects.
5. `data:import-standalone`: dry run, execute and verify, through a
   read-only BYPASSRLS login.
6. Attendance roles and migrations; a synthetic 48k-event SQLite database
   imported with a dry run, execute and verify, and the source file hash and
   directory checked unchanged.
7. Platform migration lock: all five migration/import tools are refused
   while another holder has it, then all releases pass.
8. The expected operations for each runtime login.
9. The security matrix for 11 roles.
10. The SECURITY DEFINER audit.
11. Backups: full, per schema, roles (no passwords), database settings and
    storage, with SHA-256 sums.
12. Restore into the separate recovery cluster, with roles re-provisioned
    under fresh passwords.
13. The matching releases, then fingerprint equality, Attendance report
    equality, Permit document hashes, ESDMS runtime verification and the
    matrix again.
14. Per-schema restores.
15. Application rollback.

Passwords are generated into a private temporary directory, never printed,
and deleted on exit. Reports hold counts, digests and catalog lines only.

## Fingerprint normalization

`pg_dump`/`pg_restore` re-parse some definitions without changing their
meaning, so two things are compared normalized:
- ACLs are compared as **effective** privileges: a NULL ACL is its
  `acldefault`.
- CHECK constraints are compared without the casts and redundant
  parentheses that the restore re-parses (`(ARRAY[..])::text[]` vs
  `ARRAY[(..)::text, ..]`).

Boolean grouping parentheses are kept. Any different value, column, table,
grouping or privilege still fails.
