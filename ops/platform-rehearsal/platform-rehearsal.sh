#!/usr/bin/env bash
# DISPOSABLE LOCAL REHEARSAL of the complete E-Set shared database and its
# go-live procedure (docs/PLATFORM_GO_LIVE_RUNBOOK.md). Never point it at a
# real database: it refuses a non-localhost PGHOST and needs an explicit
# confirmation.
#
# Builds, in the production order, ONE database holding
#   public     ESDMS      (its own db:release: 48 migrations + runtime provisioning)
#   permit     Permit     (roles, baseline without reference data + 0039-0042,
#                          then the standalone import of a synthetic OLD database)
#   attendance Attendance (roles, migrations, then the SQLite import of a
#                          synthetic 48k-event database)
# and proves: platform migration serialization, the cross-application
# security matrix with real logins, the SECURITY DEFINER / search_path
# audit, full and per-schema backup + restore into a SEPARATE fresh cluster,
# and the matching releases on the restored copy.
#
# Requirements (throwaway clusters only):
#   PLATFORM_REHEARSAL_DISPOSABLE_CLUSTER=yes
#   PGHOST=localhost PGPORT=<platform cluster> RECOVERY_PGPORT=<empty recovery cluster>
#   STANDALONE_PGPORT=<empty cluster for the OLD standalone Permit database: a separate
#                      project in production, so its BYPASSRLS reader never exists beside the platform>
#   PGUSER=<superuser of all three> PGPASSFILE=<its passfile, all ports>
#   ESDMS_BACKEND=<clean ESDMS backend export: git archive + npm ci, no .env>
#   ESDMS_REPO=<ESDMS git checkout>   (application rollback: previous builds are exported from Git)
#   ROLLBACK_ESDMS_COMMIT / ROLLBACK_PERMIT_COMMIT / ROLLBACK_ATTENDANCE_OLD_COMMIT
#                        (previous known-good builds; see step 15)
#   PERMIT_REPO=<Permit checkout with backend/node_modules>
#   ATTENDANCE_REPO=<Attendance checkout with backend/node_modules>
#   REHEARSAL_REPORT_DIR=<empty directory for reports and backups>
# Every role password is generated into a private temporary directory,
# never printed, and deleted on exit. Reports hold counts, digests and
# catalog lines only.
set -euo pipefail

[[ "${PLATFORM_REHEARSAL_DISPOSABLE_CLUSTER:-}" == "yes" ]] || { echo "Refusing: set PLATFORM_REHEARSAL_DISPOSABLE_CLUSTER=yes." >&2; exit 1; }
case "${PGHOST:-}" in localhost|127.0.0.1) ;; *) echo "Refusing: PGHOST must be localhost." >&2; exit 1 ;; esac
for v in PGPORT RECOVERY_PGPORT STANDALONE_PGPORT PGUSER PGPASSFILE ESDMS_BACKEND ESDMS_REPO PERMIT_REPO ATTENDANCE_REPO REHEARSAL_REPORT_DIR \
         ROLLBACK_ESDMS_COMMIT ROLLBACK_PERMIT_COMMIT ROLLBACK_ATTENDANCE_OLD_COMMIT; do
  [[ -n "${!v:-}" ]] || { echo "$v is required." >&2; exit 1; }
done
[[ ! -e "$ESDMS_BACKEND/.env" && ! -e "$PERMIT_REPO/backend/.env" && ! -e "$ATTENDANCE_REPO/backend/.env" ]] \
  || { echo "Refusing: a checkout contains a .env; use clean exports." >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPORT="$REHEARSAL_REPORT_DIR"
DB=eset_platform
STANDALONE=permit_standalone
SECRETS="$(umask 077 && mktemp -d)"
BACKGROUND_PID=""
trap '[[ -n "$BACKGROUND_PID" ]] && kill "$BACKGROUND_PID" 2>/dev/null; rm -rf "$SECRETS"' EXIT
mkdir -p "$REPORT"/{backups,storage}
PSQL=(psql --no-psqlrc -X -q -v ON_ERROR_STOP=1)
export PGTZ=UTC
PLATFORM_LOCK=1163085140
LOGINS=(esdms_owner esdms_runtime permit_migrator permit_runtime permit_privileged attendance_migrator attendance_runtime standalone_reader)
for role in "${LOGINS[@]}" ceo_password; do (umask 077 && openssl rand -hex 24 > "$SECRETS/$role"); done
{ cat "$PGPASSFILE"
  for port in "$PGPORT" "$RECOVERY_PGPORT" "$STANDALONE_PGPORT"; do
    for role in "${LOGINS[@]}"; do echo "$PGHOST:$port:*:$role:$(cat "$SECRETS/$role")"; done
  done; } > "$SECRETS/pgpass"
chmod 600 "$SECRETS/pgpass"

url() { echo "postgresql://$1:$(cat "$SECRETS/$1")@$PGHOST:${3:-$PGPORT}/${2:-$DB}"; }
admin() { local port=$1; shift; PGPORT=$port "${PSQL[@]}" "$@"; }
as_role() { local role=$1; shift; PGPASSFILE="$SECRETS/pgpass" PGUSER="$role" "${PSQL[@]}" -d "$DB" "$@"; }
step() { printf '\n== %s\n' "$1"; }
quiet() { local log=$1; shift; "$@" > "$REPORT/$log" 2>&1 || { echo "FAILED - see $REPORT/$log" >&2; tail -20 "$REPORT/$log" >&2; exit 1; }; }
set_password() { # port role
  PW="$(cat "$SECRETS/$2")" admin "$1" -d postgres -v role="$2" <<'SQL'
\getenv pw PW
ALTER ROLE :"role" PASSWORD :'pw';
SQL
}

# ---------------------------------------------------------------- the apps' own tooling
esdms_release() { # log [port]
  local port=${2:-$PGPORT}
  quiet "$1" env -C "$ESDMS_BACKEND" MIGRATION_DATABASE_URL="$(url esdms_owner $DB "$port")" \
    DATABASE_URL="$(url esdms_runtime $DB "$port")" ESDMS_RUNTIME_PASSWORD="$(cat "$SECRETS/esdms_runtime")" \
    npm run --silent db:release
}
permit_env() { # port
  echo "MIGRATION_DATABASE_URL=$(url permit_migrator $DB "$1") DATABASE_URL=$(url permit_runtime $DB "$1") DB_SSL=false"
  echo "SUPABASE_URL=https://placeholder.supabase.test SUPABASE_PUBLISHABLE_KEY=placeholder SITE_TIMEZONE=Asia/Karachi"
}
permit_run() { # log port command...
  local log=$1 port=$2; shift 2
  quiet "$log" env -C "$PERMIT_REPO/backend" $(permit_env "$port") "$@"
}
attendance_run() { # log port command...
  local log=$1 port=$2; shift 2
  quiet "$log" env -C "$ATTENDANCE_REPO/backend" ATTENDANCE_DB_SSL=disable \
    ATTENDANCE_MIGRATION_DATABASE_URL="$(url attendance_migrator $DB "$port")" \
    ATTENDANCE_DATABASE_URL="$(url attendance_runtime $DB "$port")" "$@"
}
provision_permit() { # port
  PERMIT_MIGRATOR_PASSWORD="$(cat "$SECRETS/permit_migrator")" PERMIT_RUNTIME_PASSWORD="$(cat "$SECRETS/permit_runtime")" \
  PERMIT_PRIVILEGED_PASSWORD="$(cat "$SECRETS/permit_privileged")" PERMIT_TRANSITIONAL_AUTH_FK=yes \
    PGPORT=$1 psql --no-psqlrc -X -q -d "$DB" -f "$PERMIT_REPO/database/roles/provision-permit-roles.sql"
}
provision_attendance() { # port
  ATTENDANCE_MIGRATOR_PASSWORD="$(cat "$SECRETS/attendance_migrator")" ATTENDANCE_RUNTIME_PASSWORD="$(cat "$SECRETS/attendance_runtime")" \
    PGPORT=$1 psql --no-psqlrc -X -q -d "$DB" -f "$ATTENDANCE_REPO/database/roles/provision-attendance-roles.sql"
}
fingerprint() { admin "$1" -d "${3:-$DB}" -f "$HERE/platform-fingerprint.sql" > "$REPORT/$2"; }
attendance_reports() { # port out: every daily report through the runtime store, digested
  attendance_run "$2.log" "$1" node --input-type=module -e '
    const { openStore } = await import("./src/db/index.js");
    const { getDailyAttendance } = await import("./src/modules/attendance/attendance.daily.js");
    const { createHash } = await import("node:crypto");
    const store = await openStore({ ...process.env, ATTENDANCE_DB_PROVIDER: "postgres" });
    const dates = [...new Set((await store.listRawEvents({ limit: 1000000 })).map((e) => e.occurred_at.slice(0, 10)))].sort();
    const hash = createHash("sha256");
    for (const date of dates) hash.update(JSON.stringify(await getDailyAttendance(store, date)));
    console.log(`dates=${dates.length} reports_sha256=${hash.digest("hex")}`);
    await store.close();'
  tail -1 "$REPORT/$2.log" > "$REPORT/$2"
}

# ================================================================== BUILD
step "1. Fresh shared database with the Supabase platform state; ESDMS release (48 migrations)"
admin "$PGPORT" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esdms_owner') THEN
    CREATE ROLE esdms_owner LOGIN NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB; END IF;
END \$\$;
CREATE DATABASE $DB OWNER esdms_owner;
SQL
set_password "$PGPORT" esdms_owner
admin "$PGPORT" -d "$DB" -c "ALTER SCHEMA public OWNER TO esdms_owner"
admin "$PGPORT" -d "$DB" -f "$PERMIT_REPO/database/verify/platform-stub.sql" > /dev/null
# Supabase's own default privileges: objects the migration owner creates in
# public are granted to the API roles unless an application revokes them.
admin "$PGPORT" -d "$DB" -c "ALTER DEFAULT PRIVILEGES FOR ROLE esdms_owner IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE esdms_owner IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
  ALTER DEFAULT PRIVILEGES FOR ROLE esdms_owner IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role" > /dev/null
esdms_release esdms-release.log
echo "ESDMS ledger: $(admin "$PGPORT" -d "$DB" -Atc 'SELECT count(*) FROM public.pgmigrations') migrations"

step "2. ESDMS business sample (CEO bootstrap through ESDMS's own script)"
quiet esdms-ceo.log env -C "$ESDMS_BACKEND" DATABASE_URL="$(url esdms_runtime)" JWT_SECRET="$(openssl rand -hex 32)" \
  FRONTEND_ORIGIN=http://localhost:5173 CEO_EMAIL=ceo.rehearsal@example.test CEO_FULL_NAME="Rehearsal CEO" \
  CEO_PASSWORD="$(cat "$SECRETS/ceo_password")" node scripts/create-ceo-user.js
echo "ESDMS users: $(admin "$PGPORT" -d "$DB" -Atc 'SELECT count(*) FROM public.users')"

step "3. Permit roles; baseline WITHOUT reference data + 0039-0042 (the data-import target)"
provision_permit "$PGPORT"
permit_run permit-migrate.log "$PGPORT" npx tsx src/db/migrate.ts --baseline-without-reference-data
echo "Permit ledger: $(admin "$PGPORT" -d "$DB" -Atc 'SELECT count(*) FROM permit.schema_migrations') migrations"

step "4. Synthetic OLD standalone Permit database (0001-0038 replay + auth.users + history + legacy objects)"
admin "$STANDALONE_PGPORT" -d postgres <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN CREATE ROLE app_runtime NOLOGIN BYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'privileged_runtime') THEN CREATE ROLE privileged_runtime NOLOGIN NOBYPASSRLS NOINHERIT; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'standalone_reader') THEN CREATE ROLE standalone_reader LOGIN INHERIT BYPASSRLS; END IF;
END \$\$;
CREATE DATABASE $STANDALONE OWNER postgres;
SQL
set_password "$STANDALONE_PGPORT" standalone_reader
admin "$STANDALONE_PGPORT" -d "$STANDALONE" -f "$PERMIT_REPO/database/baseline/tools/supabase-platform-emulation.sql" > /dev/null
admin "$STANDALONE_PGPORT" -d "$STANDALONE" -c "ALTER DATABASE $STANDALONE SET search_path = \"\$user\", public, extensions"
admin "$STANDALONE_PGPORT" -d "$STANDALONE" -c "CREATE TABLE public.schema_migrations (id SERIAL PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
for file in "$PERMIT_REPO"/database/migrations/00[0-3][0-9]_*.sql; do
  [[ $((10#$(basename "$file" | cut -c1-4))) -le 38 ]] || continue
  admin "$STANDALONE_PGPORT" -d "$STANDALONE" -1 -f "$file" > /dev/null 2>&1 || { echo "standalone replay failed at $(basename "$file")" >&2; exit 1; }
done
quiet standalone-build.log env -C "$PERMIT_REPO/backend" $(permit_env "$PGPORT") STANDALONE_REHEARSAL_URL="postgresql://$PGUSER@$PGHOST:$STANDALONE_PGPORT/$STANDALONE" \
  PGPASSFILE="$PGPASSFILE" LEGACY_OBJECTS_DIR="$REPORT/storage/permit-legacy" npx tsx src/test/buildStandaloneRehearsalDb.ts
# The import reads the standalone database with a read-only login that sees every row
# (RLS is enabled there; row_security=off makes a filtered login fail, never read empty).
admin "$STANDALONE_PGPORT" -d "$STANDALONE" -c "GRANT pg_read_all_data TO standalone_reader"
echo "Standalone: $(admin "$STANDALONE_PGPORT" -d "$STANDALONE" -Atc "SELECT (SELECT count(*) FROM auth.users) || ' identities, ' || (SELECT count(*) FROM public.permits) || ' permits, ' || (SELECT count(*) FROM public.permit_document_jobs WHERE status = 'GENERATED') || ' generated documents'"); $(tail -1 "$REPORT/standalone-build.log")"

step "5. Permit standalone -> shared import: dry run, execute, verify"
import_env=(STANDALONE_DATABASE_URL="$(url standalone_reader $STANDALONE "$STANDALONE_PGPORT")")
for mode in "" --execute --verify; do
  permit_run "permit-import${mode:-"-dry-run"}.json" "$PGPORT" env "${import_env[@]}" npx tsx src/scripts/importStandalone.ts $mode
  python3 - "$REPORT/permit-import${mode:-"-dry-run"}.json" "${mode:-dry-run}" <<'PY'
import json, sys
text = open(sys.argv[1]).read(); report = json.loads(text[text.index('{'):])
tables = report['tables']
assert not report['problems'] and not report['identityProblems'], report['problems']
assert all(t['match'] for t in tables.values()) and report['users']['match'] and report['sequences']['match']
assert tables['permits']['source'] >= 4 and tables['permit_signatures']['source'] > 0 and report['samples']['permitSequences'], 'history rows must actually arrive'
assert all(count > 0 for count in report['identityReferences'].values()), report['identityReferences']
print(f"  {sys.argv[2]:>9}: committed={report['committed']} tables={len(tables)} rows={sum(t['source'] for t in tables.values())} "
      f"identities={report['users']['target']}/{report['users']['source']} relationships={len(report['identityReferences'])} "
      f"sequences={report['sequences']['compared']} hash_formats={report['hashPrefixCounts']} permits={report['samples']['permitSequences']}")
PY
done

step "6. Attendance roles, migrations; synthetic SQLite (48k events) -> PostgreSQL import"
provision_attendance "$PGPORT"
attendance_run attendance-migrate.log "$PGPORT" node src/db/migrate.js
tail -1 "$REPORT/attendance-migrate.log"
SQLITE="$REPORT/storage/attendance/attendance.db"
mkdir -p "$(dirname "$SQLITE")"
attendance_run attendance-sqlite-build.log "$PGPORT" node test/fixtures/rehearsal-sqlite.js "$SQLITE"
echo "SQLite source: $(tail -1 "$REPORT/attendance-sqlite-build.log")"
source_before="$(shasum -a 256 "$SQLITE" | cut -c1-64) $(ls "$(dirname "$SQLITE")" | tr '\n' ' ')"
for mode in "" --execute --verify; do
  attendance_run "attendance-import${mode:-"-dry-run"}.json" "$PGPORT" node scripts/sqlite-to-postgres.js --sqlite "$SQLITE" $mode
  python3 - "$REPORT/attendance-import${mode:-"-dry-run"}.json" "${mode:-dry-run}" <<'PY'
import json, sys
text = open(sys.argv[1]).read(); r = json.loads(text[text.index('{'):])
assert not r['problems'] and not r['mismatches'], (r['problems'], r['mismatches'])
print(f"  {sys.argv[2]:>9}: committed={r['committed']} source={r['source']} report_dates={r['reportDates']} inserted={r.get('inserted')} sequences={r.get('sequences')}")
PY
done
[[ "$source_before" == "$(shasum -a 256 "$SQLITE" | cut -c1-64) $(ls "$(dirname "$SQLITE")" | tr '\n' ' ')" ]] \
  || { echo "SQLITE SOURCE CHANGED" >&2; exit 1; }
echo "SQLite source file hash and directory unchanged"

# ================================================================== PROOFS
step "7. Platform migration serialization: one application's DDL at a time"
admin "$PGPORT" -d "$DB" -c "SELECT pg_advisory_lock($PLATFORM_LOCK), pg_sleep(600)" > /dev/null 2>&1 &
BACKGROUND_PID=$!
sleep 2
expect_refused() { # label command...
  local label=$1; shift
  if "$@" > "$REPORT/lock-$label.log" 2>&1; then echo "  $label RAN while another release held the platform lock" >&2; exit 1; fi
  grep -q "platform lock" "$REPORT/lock-$label.log" || { echo "  $label failed for another reason (see lock-$label.log)" >&2; exit 1; }
  echo "  refused while locked: $label"
}
expect_refused esdms-db-release env -C "$ESDMS_BACKEND" MIGRATION_DATABASE_URL="$(url esdms_owner)" DATABASE_URL="$(url esdms_runtime)" \
  ESDMS_RUNTIME_PASSWORD="$(cat "$SECRETS/esdms_runtime")" npm run --silent db:release
expect_refused permit-migrate env -C "$PERMIT_REPO/backend" $(permit_env "$PGPORT") npx tsx src/db/migrate.ts
expect_refused permit-import env -C "$PERMIT_REPO/backend" $(permit_env "$PGPORT") "${import_env[@]}" npx tsx src/scripts/importStandalone.ts --verify
expect_refused attendance-migrate env -C "$ATTENDANCE_REPO/backend" ATTENDANCE_DB_SSL=disable \
  ATTENDANCE_MIGRATION_DATABASE_URL="$(url attendance_migrator)" node src/db/migrate.js
expect_refused attendance-import env -C "$ATTENDANCE_REPO/backend" ATTENDANCE_DB_SSL=disable \
  ATTENDANCE_MIGRATION_DATABASE_URL="$(url attendance_migrator)" node scripts/sqlite-to-postgres.js --sqlite "$SQLITE" --verify
# Ending the client does not end the server-side sleep: terminate the holder's backend.
admin "$PGPORT" -d postgres -Atc "SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype = 'advisory'
  AND ((classid::bigint << 32) | objid::bigint) = $PLATFORM_LOCK" > /dev/null
wait "$BACKGROUND_PID" 2>/dev/null || true; BACKGROUND_PID=""
esdms_release esdms-release-2.log
permit_run permit-migrate-2.log "$PGPORT" npx tsx src/db/migrate.ts
attendance_run attendance-migrate-2.log "$PGPORT" node src/db/migrate.js
echo "  released: ESDMS db:release passed; Permit: $(tail -1 "$REPORT/permit-migrate-2.log"); Attendance: $(tail -1 "$REPORT/attendance-migrate-2.log")"
echo "  runtime code taking the platform lock: $(grep -rlE "$PLATFORM_LOCK|1_163_085_140" "$ESDMS_BACKEND/src" "$PERMIT_REPO/backend/src/routes" "$PERMIT_REPO/backend/src/domain" "$ATTENDANCE_REPO/backend/src/app.js" "$ATTENDANCE_REPO/backend/src/modules" 2>/dev/null | wc -l | tr -d ' ') files"

step "8. Expected operations as each runtime login"
quiet esdms-verify-runtime.log env -C "$ESDMS_BACKEND" DATABASE_URL="$(url esdms_runtime)" node scripts/verify-runtime-db.js
echo "  esdms_runtime: ESDMS verify-runtime-db passed"
cat > "$REPORT/permit-runtime-login.mts" <<TS
const { login } = await import("$PERMIT_REPO/backend/src/domain/auth/login.ts");
const { query, withTransaction, closePool } = await import("$PERMIT_REPO/backend/src/db/pool.ts");
const ok = await login({ email: "HSE@example.test", password: "FAKE-standalone-password-1", remember: false }, { query, withTransaction });
const scheme = (await query("SELECT password_scheme FROM users WHERE email = \$1", ["hse@example.test"])).rows[0].password_scheme;
const permits = (await query("SELECT count(*)::int AS n FROM permits")).rows[0].n;
console.log(\`login=\${ok.outcome} scheme_after=\${scheme} permits_visible=\${permits}\`);
await closePool();
TS
permit_run permit-runtime-login.log "$PGPORT" npx tsx "$REPORT/permit-runtime-login.mts"
echo "  permit_runtime: imported identity signs in with its bcrypt password; $(tail -1 "$REPORT/permit-runtime-login.log")"
echo "  permit_privileged may EXECUTE: $(as_role permit_privileged -Atc "SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY 1) FROM pg_proc p WHERE p.pronamespace = 'permit'::regnamespace AND has_function_privilege(p.oid, 'EXECUTE')")"
attendance_run attendance-runtime-smoke.log "$PGPORT" node ../database/verify/attendance-runtime-smoke.mjs
echo "  attendance_runtime: $(tail -1 "$REPORT/attendance-runtime-smoke.log")"

step "9. Cross-application security matrix (real logins; Supabase API roles via SET ROLE)"
for entry in esdms_runtime:public:runtime permit_runtime:permit:runtime permit_privileged:permit:runtime \
             attendance_runtime:attendance:runtime permit_migrator:permit:owner attendance_migrator:attendance:owner; do
  IFS=: read -r role own kind <<< "$entry"
  as_role "$role" -v own="$own" -v kind="$kind" -f "$HERE/security-matrix.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /'
done
# service_role included: ESDMS provisioning revokes Supabase's default grants, so
# it is denied on ESDMS objects exactly like the browser roles (and on Permit/Attendance).
for role in anon authenticated service_role; do
  admin "$PGPORT" -d "$DB" -c "SET ROLE $role" -v own=none -v kind=runtime -f "$HERE/security-matrix.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  /'
done
as_role esdms_owner -Atc "SELECT 'esdms_owner (migration owner): createrole=' || rolcreaterole || ' bypassrls=' || rolbypassrls FROM pg_roles WHERE rolname = current_user"

step "10. SECURITY DEFINER / search_path / dynamic SQL audit"
admin "$PGPORT" -d "$DB" -f "$HERE/security-definer-audit.sql" > "$REPORT/security-definer-audit.txt" 2>&1 \
  || { cat "$REPORT/security-definer-audit.txt" >&2; exit 1; }
grep -E "NOTICE|rows\)" "$REPORT/security-definer-audit.txt" | sed 's/^psql:[^ ]* NOTICE:  /  /'

# ================================================================== BACKUP / RESTORE
step "11. Backups: full, per schema, roles (no passwords), storage"
fingerprint "$PGPORT" fingerprint-before.txt
attendance_reports "$PGPORT" attendance-reports-before.txt
echo "Attendance reports before backup: $(cat "$REPORT/attendance-reports-before.txt")"
PGPORT=$PGPORT pg_dump -d "$DB" -Fc -f "$REPORT/backups/full.dump"
for schema in public permit attendance; do PGPORT=$PGPORT pg_dump -d "$DB" -Fc -n "$schema" -f "$REPORT/backups/$schema.dump"; done
PGPORT=$PGPORT pg_dumpall --roles-only --no-role-passwords | grep -vE "^(CREATE|ALTER) ROLE $PGUSER( |;)" > "$REPORT/backups/roles.sql"
# pg_dump does not carry database-level settings (e.g. Supabase's search_path): capture them.
admin "$PGPORT" -d "$DB" -At > "$REPORT/backups/database-settings.sql" <<'SQL'
-- search_path is a quoted list: its stored text is already valid SQL; other values are literals.
SELECT format('ALTER DATABASE %I SET %s TO %s;', current_database(), split_part(c, '=', 1),
              CASE WHEN split_part(c, '=', 1) = 'search_path' THEN substr(c, strpos(c, '=') + 1)
                   ELSE quote_literal(substr(c, strpos(c, '=') + 1)) END)
  FROM pg_db_role_setting s, unnest(s.setconfig) c
 WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database());
SQL
tar -C "$REPORT/storage" -cf "$REPORT/backups/storage.tar" permit-legacy attendance
(cd "$REPORT/backups" && shasum -a 256 full.dump public.dump permit.dump attendance.dump roles.sql database-settings.sql storage.tar > SHA256SUMS)
echo "Backups: $(cd "$REPORT/backups" && ls | tr '\n' ' ')"
if grep -qiE "password|scram-sha" "$REPORT/backups/roles.sql"; then echo "roles.sql contains password material" >&2; exit 1; fi
echo "roles.sql holds no password material"

step "12. Restore into a SEPARATE, empty recovery cluster"
(cd "$REPORT/backups" && shasum -a 256 -c SHA256SUMS > /dev/null) && echo "backup checksums verified"
admin "$RECOVERY_PGPORT" -d postgres -f "$REPORT/backups/roles.sql" > "$REPORT/restore-roles.log" 2>&1
admin "$RECOVERY_PGPORT" -d postgres -c "CREATE DATABASE $DB OWNER esdms_owner"
admin "$RECOVERY_PGPORT" -d "$DB" -f "$REPORT/backups/database-settings.sql" > /dev/null
PGPORT=$RECOVERY_PGPORT pg_restore --exit-on-error -d "$DB" "$REPORT/backups/full.dump"
for role in esdms_owner; do set_password "$RECOVERY_PGPORT" "$role"; done
provision_permit "$RECOVERY_PGPORT"
provision_attendance "$RECOVERY_PGPORT"
mkdir -p "$REPORT/restored-storage" && tar -C "$REPORT/restored-storage" -xf "$REPORT/backups/storage.tar"
echo "Roles re-provisioned with fresh passwords; storage restored"

step "13. Matching releases on the restored database, then verification"
esdms_release esdms-release-recovery.log "$RECOVERY_PGPORT"
permit_run permit-migrate-recovery.log "$RECOVERY_PGPORT" npx tsx src/db/migrate.ts
attendance_run attendance-migrate-recovery.log "$RECOVERY_PGPORT" node src/db/migrate.js
echo "Releases: ESDMS db:release passed; Permit: $(tail -1 "$REPORT/permit-migrate-recovery.log"); Attendance: $(tail -1 "$REPORT/attendance-migrate-recovery.log")"
fingerprint "$RECOVERY_PGPORT" fingerprint-restored.txt
if diff -u "$REPORT/fingerprint-before.txt" "$REPORT/fingerprint-restored.txt" > "$REPORT/fingerprint.diff"; then
  echo "Restored database identical: $(grep -c '^rows ' "$REPORT/fingerprint-before.txt") tables (counts + content digests), $(wc -l < "$REPORT/fingerprint-before.txt" | tr -d ' ') catalog/data lines incl. ledgers, grants, roles"
else
  echo "RESTORED DATABASE DIFFERS - see $REPORT/fingerprint.diff" >&2; head -40 "$REPORT/fingerprint.diff" >&2; exit 1
fi
attendance_reports "$RECOVERY_PGPORT" attendance-reports-restored.txt
diff -q "$REPORT/attendance-reports-before.txt" "$REPORT/attendance-reports-restored.txt" > /dev/null \
  && echo "Attendance reports identical after restore: $(cat "$REPORT/attendance-reports-restored.txt")"
restored_documents=$(admin "$RECOVERY_PGPORT" -d "$DB" -Atc "SELECT storage_path || ' ' || file_hash FROM permit.permit_document_jobs WHERE status = 'GENERATED' ORDER BY 1" |
  while read -r key hash; do [[ "$(shasum -a 256 "$REPORT/restored-storage/permit-legacy/$key" | cut -c1-64)" == "$hash" ]] && echo ok; done | wc -l | tr -d ' ')
echo "Permit document hashes: $restored_documents restored legacy objects match their pinned job hashes"
quiet esdms-verify-runtime-recovery.log env -C "$ESDMS_BACKEND" DATABASE_URL="$(url esdms_runtime $DB "$RECOVERY_PGPORT")" node scripts/verify-runtime-db.js
echo "ESDMS runtime verification passed on the restored database"
PGPORT=$RECOVERY_PGPORT as_role attendance_runtime -v own=attendance -v kind=runtime -f "$HERE/security-matrix.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  restored /'
PGPORT=$RECOVERY_PGPORT as_role permit_runtime -v own=permit -v kind=runtime -f "$HERE/security-matrix.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  restored /'
PGPORT=$RECOVERY_PGPORT as_role esdms_runtime -v own=public -v kind=runtime -f "$HERE/security-matrix.sql" 2>&1 | sed 's/^psql:[^ ]* NOTICE:  /  restored /'

step "14. Per-schema restores (each application alone, into its own fresh database)"
for schema in public permit attendance; do
  target="restore_$schema"
  admin "$RECOVERY_PGPORT" -d postgres -c "CREATE DATABASE $target OWNER esdms_owner"
  admin "$RECOVERY_PGPORT" -d "$target" -f "$PERMIT_REPO/database/verify/platform-stub.sql" > /dev/null
  # The ESDMS dump recreates schema public itself (owner and grants included).
  [[ $schema != public ]] || admin "$RECOVERY_PGPORT" -d "$target" -c "DROP SCHEMA public CASCADE" > /dev/null 2>&1
  PGPORT=$RECOVERY_PGPORT pg_restore --exit-on-error -d "$target" "$REPORT/backups/$schema.dump"
  admin "$RECOVERY_PGPORT" -d "$target" -f "$HERE/platform-fingerprint.sql" | grep "^rows $schema\." > "$REPORT/schema-$schema-restored.txt"
  grep "^rows $schema\." "$REPORT/fingerprint-before.txt" | diff -q - "$REPORT/schema-$schema-restored.txt" > /dev/null \
    && echo "  $schema: $(wc -l < "$REPORT/schema-$schema-restored.txt" | tr -d ' ') tables restored alone, contents identical"
done

# ================================================================== APPLICATION ROLLBACK
step "15. Application rollback: previous builds against the current database (no down migrations)"
RB="$REPORT/rollback"; mkdir -p "$RB"
export_build() { # repo commit dir -> <dir>/backend with the checkout's node_modules
  mkdir -p "$3"; git -C "$1" archive "$2" backend database 2>/dev/null | tar -x -C "$3" \
    || git -C "$1" archive "$2" backend | tar -x -C "$3"
  ln -s "$4" "$3/backend/node_modules"
}
# Attendance: a NEXT build adds an expand-only migration (nullable column);
# the CURRENT build is then the rollback target on that database.
export_build "$ATTENDANCE_REPO" HEAD "$RB/attendance-next" "$ATTENDANCE_REPO/backend/node_modules"
printf -- '-- Rehearsal only: an expand-only change a later release might make.\nALTER TABLE attendance.devices ADD COLUMN rehearsal_note text;\n' \
  > "$RB/attendance-next/database/migrations/0003_rehearsal_expand.sql"
quiet rollback-attendance-next-migrate.log env -C "$RB/attendance-next/backend" ATTENDANCE_DB_SSL=disable \
  ATTENDANCE_MIGRATION_DATABASE_URL="$(url attendance_migrator)" node src/db/migrate.js
echo "  next Attendance build: $(tail -1 "$REPORT/rollback-attendance-next-migrate.log")"
attendance_run rollback-attendance-current-smoke.log "$PGPORT" node ../database/verify/attendance-runtime-smoke.mjs
echo "  rolled back to the current Attendance build on the newer ledger: $(tail -1 "$REPORT/rollback-attendance-current-smoke.log")"
if env -C "$ATTENDANCE_REPO/backend" ATTENDANCE_DB_SSL=disable ATTENDANCE_MIGRATION_DATABASE_URL="$(url attendance_migrator)" \
     node src/db/migrate.js > "$REPORT/rollback-attendance-current-migrate.log" 2>&1; then
  echo "  the rolled-back runner applied something against a newer ledger" >&2; exit 1
fi
echo "  the rolled-back build's migration runner refuses the newer ledger (rollback never runs migrations): $(grep -o 'Applied migration 3 has no file' "$REPORT/rollback-attendance-current-migrate.log" | head -1)"
export_build "$ATTENDANCE_REPO" "$ROLLBACK_ATTENDANCE_OLD_COMMIT" "$RB/attendance-old" "$ATTENDANCE_REPO/backend/node_modules"
old_ready=$(env -C "$RB/attendance-old/backend" ATTENDANCE_DB_SSL=disable ATTENDANCE_DATABASE_URL="$(url attendance_runtime)" \
  node --input-type=module -e '
    const { openStore } = await import("./src/db/index.js");
    const store = await openStore({ ...process.env, ATTENDANCE_DB_PROVIDER: "postgres" });
    try { await store.ready(); console.log("ready"); } catch { console.log("NOT READY"); } finally { await store.close(); }' 2>/dev/null | tail -1)
echo "  pre-Phase-6 Attendance build ($ROLLBACK_ATTENDANCE_OLD_COMMIT) against this database: $old_ready (documented: its readiness predates rollback tolerance)"
admin "$PGPORT" -d "$DB" -c "ALTER TABLE attendance.devices DROP COLUMN rehearsal_note; DELETE FROM attendance.schema_migrations WHERE version = 3" > /dev/null

# Permit: the previous build (no Permit migration since) on the Phase 6 database.
export_build "$PERMIT_REPO" "$ROLLBACK_PERMIT_COMMIT" "$RB/permit-previous" "$PERMIT_REPO/backend/node_modules"
quiet rollback-permit-previous-migrate.log env -C "$RB/permit-previous/backend" $(permit_env "$PGPORT") npx tsx src/db/migrate.ts
sed "s|$PERMIT_REPO/backend|$RB/permit-previous/backend|g; s|HSE@example.test|CRO@example.test|; s|hse@example.test|cro@example.test|" \
  "$REPORT/permit-runtime-login.mts" > "$RB/permit-previous-login.mts"
quiet rollback-permit-previous-login.log env -C "$RB/permit-previous/backend" $(permit_env "$PGPORT") npx tsx "$RB/permit-previous-login.mts"
echo "  previous Permit build ($ROLLBACK_PERMIT_COMMIT): runner $(tail -1 "$REPORT/rollback-permit-previous-migrate.log"); imported login $(tail -1 "$REPORT/rollback-permit-previous-login.log")"

# ESDMS: the previous build verifies its runtime against the current database.
export_build "$ESDMS_REPO" "$ROLLBACK_ESDMS_COMMIT" "$RB/esdms-previous" "$ESDMS_BACKEND/node_modules"
quiet rollback-esdms-previous-verify.log env -C "$RB/esdms-previous/backend" DATABASE_URL="$(url esdms_runtime)" node scripts/verify-runtime-db.js
echo "  previous ESDMS build ($ROLLBACK_ESDMS_COMMIT): runtime verification passed against the current database"

step "Rehearsal passed. Reports and backups: $REPORT"
