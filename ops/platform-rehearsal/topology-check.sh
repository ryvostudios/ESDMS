#!/usr/bin/env bash
# DISPOSABLE LOCAL CHECK of the production topology assumptions
# (docs/PLATFORM_GO_LIVE_RUNBOOK.md, "Domains, cookies and CORS"): the real
# ESDMS and Permit backends side by side on the platform-rehearsal database,
# addressed by company-style hostnames through curl --resolve (no DNS or
# hosts-file change). Proves host-only HttpOnly SameSite=Lax cookies that
# never cross applications, credentialed CORS only for each application's
# own frontend, Origin-checked mutations, a session-bound Dropbox callback,
# and public branding/PWA fallbacks with no CMS branding or storage.
#
#   TOPOLOGY_WORK_DIR=<empty dir> ESDMS_BACKEND=<clean export> PERMIT_BACKEND=<checkout>/backend \
#   PGHOST=localhost PGPORT=<platform rehearsal cluster> PGUSER=<superuser> PGPASSFILE=<passfile> \
#     ops/platform-rehearsal/topology-check.sh
# Needs the database left by platform-rehearsal.sh (it signs in as the
# imported synthetic CRO). Rotates the two runtime passwords in that
# disposable cluster; never point it at a real one.
set -euo pipefail
case "${PGHOST:-}" in localhost|127.0.0.1) ;; *) echo "Refusing: PGHOST must be localhost." >&2; exit 1 ;; esac
DIR="$TOPOLOGY_WORK_DIR"; ESDMS="$ESDMS_BACKEND"; PERMIT="$PERMIT_BACKEND"
S="$(umask 077 && mktemp -d "$DIR/secrets.XXXX")"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$S"' EXIT
for r in esdms_runtime permit_runtime ceo; do (umask 077; openssl rand -hex 24 > "$S/$r"); done
for r in esdms_runtime permit_runtime; do PW="$(cat "$S/$r")" psql --no-psqlrc -X -q -d postgres -v role=$r <<'SQL'
\getenv pw PW
ALTER ROLE :"role" PASSWORD :'pw';
SQL
done
DB="$PGHOST:$PGPORT/eset_platform"; RUN=$(openssl rand -hex 4)
APP=http://app.eset.localhost:5173; PERMIT_FE=http://permit.eset.localhost:5174
env -C "$ESDMS" DATABASE_URL="postgresql://esdms_runtime:$(cat "$S/esdms_runtime")@$DB" JWT_SECRET="$(openssl rand -hex 32)" \
  FRONTEND_ORIGIN="$APP" CEO_EMAIL=topology.ceo.$RUN@example.test CEO_FULL_NAME="Topology CEO" CEO_PASSWORD="$(cat "$S/ceo")" \
  node scripts/create-ceo-user.js > "$DIR/ceo.log" 2>&1
env -C "$ESDMS" DATABASE_URL="postgresql://esdms_runtime:$(cat "$S/esdms_runtime")@$DB" JWT_SECRET="$(openssl rand -hex 32)" \
  FRONTEND_ORIGIN="$APP" PORT=4101 node src/server.js > "$DIR/esdms.log" 2>&1 &
env -C "$PERMIT" DATABASE_URL="postgresql://permit_runtime:$(cat "$S/permit_runtime")@$DB" DB_SSL=false SITE_TIMEZONE=Asia/Karachi \
  SUPABASE_URL=https://placeholder.supabase.test SUPABASE_PUBLISHABLE_KEY=placeholder CORS_ALLOWED_ORIGINS="$PERMIT_FE" PORT=4102 \
  npx tsx src/index.ts > "$DIR/permit.log" 2>&1 &
for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:4101/api/v1/health && curl -sf -o /dev/null http://127.0.0.1:4102/health && break; sleep 1; done
JAR="$DIR/jar.txt"; rm -f "$JAR"
C=(curl -s --resolve api.eset.localhost:4101:127.0.0.1 --resolve permit-api.eset.localhost:4102:127.0.0.1 -b "$JAR" -c "$JAR")
E=http://api.eset.localhost:4101/api/v1; P=http://permit-api.eset.localhost:4102/api/v1
check() { if eval "$2"; then echo "  PASS $1"; else echo "  FAIL $1"; FAILED=1; fi; }
FAILED=0

echo "== Sign-in on each application from its own frontend origin"
esdms_login=$("${C[@]}" -D - -o /dev/null -H "Origin: $APP" -H 'Content-Type: application/json' \
  --data "{\"email\":\"topology.ceo.$RUN@example.test\",\"password\":\"$(cat "$S/ceo")\"}" "$E/auth/login")
permit_login=$("${C[@]}" -D - -o /dev/null -H "Origin: $PERMIT_FE" -H 'Content-Type: application/json' \
  --data '{"email":"cro@example.test","password":"FAKE-standalone-password-1"}' "$P/auth/login")
ec=$(grep -i '^set-cookie: esdms_session' <<< "$esdms_login" | tr -d '\r'); pc=$(grep -i '^set-cookie: permit_session' <<< "$permit_login" | tr -d '\r')
check "ESDMS cookie esdms_session: HttpOnly, SameSite=Lax, Path=/, host-only (no Domain)" \
  '[[ "$ec" =~ HttpOnly && "$ec" =~ SameSite=Lax && "$ec" =~ Path=/\; && ! "$ec" =~ [Dd]omain= ]]'
check "Permit cookie permit_session: HttpOnly, SameSite=Lax, Path=/api/v1, host-only (no Domain)" \
  '[[ "$pc" =~ HttpOnly && "$pc" =~ SameSite=Lax && "$pc" =~ Path=/api/v1 && ! "$pc" =~ [Dd]omain= ]]'
check "cookie jar: each cookie bound to its own host only" \
  '[[ $(grep -c "esdms_session" "$JAR") == 1 && $(grep "esdms_session" "$JAR" | cut -f1) == "#HttpOnly_api.eset.localhost" && $(grep "permit_session" "$JAR" | cut -f1) == "#HttpOnly_permit-api.eset.localhost" && $(grep "esdms_session" "$JAR" | cut -f2) == FALSE && $(grep "permit_session" "$JAR" | cut -f2) == FALSE ]]'

echo "== No cross-application session"
sent_to_permit=$("${C[@]}" -v -o /dev/null "$P/auth/me" 2>&1 | grep -i '^> cookie' || true)
sent_to_esdms=$("${C[@]}" -v -o /dev/null "$E/auth/me" 2>&1 | grep -i '^> cookie' || true)
check "the browser-equivalent jar sends only permit_session to the Permit API" '[[ "$sent_to_permit" =~ permit_session && ! "$sent_to_permit" =~ esdms_session ]]'
check "and only esdms_session to the ESDMS API" '[[ "$sent_to_esdms" =~ esdms_session && ! "$sent_to_esdms" =~ permit_session ]]'
esdms_token=$(grep esdms_session "$JAR" | cut -f7); permit_token=$(grep permit_session "$JAR" | cut -f7)
check "Permit refuses an ESDMS session (even under its own cookie name)" \
  '[[ $(curl -s -o /dev/null -w "%{http_code}" --resolve permit-api.eset.localhost:4102:127.0.0.1 -H "Cookie: permit_session=$esdms_token" "$P/auth/me") == 401 ]]'
check "ESDMS refuses a Permit session (even under its own cookie name)" \
  '[[ $(curl -s -o /dev/null -w "%{http_code}" --resolve api.eset.localhost:4101:127.0.0.1 -H "Cookie: esdms_session=$permit_token" "$E/auth/me") == 401 ]]'

echo "== CORS and Origin validation"
acao() { curl -s -D - -o /dev/null --resolve api.eset.localhost:4101:127.0.0.1 --resolve permit-api.eset.localhost:4102:127.0.0.1 \
  -X OPTIONS -H "Origin: $1" -H "Access-Control-Request-Method: POST" -H "Access-Control-Request-Headers: content-type" "$2" \
  | tr -d '\r' | tr 'A-Z' 'a-z' | grep "^access-control-allow-origin:\|^access-control-allow-credentials:" | tr '\n' ' '; }
check "ESDMS API: credentialed CORS for its own frontend only" \
  '[[ "$(acao $APP $E/auth/login)" =~ "allow-origin: $APP" && "$(acao $APP $E/auth/login)" =~ "credentials: true" && ! "$(acao $PERMIT_FE $E/auth/login)" =~ allow-origin ]]'
check "Permit API: credentialed CORS for its own frontend only" \
  '[[ "$(acao $PERMIT_FE $P/auth/login)" =~ "allow-origin: $PERMIT_FE" && ! "$(acao $APP $P/auth/login)" =~ allow-origin && ! "$(acao https://evil.example $P/auth/login)" =~ allow-origin ]]'
check "Permit refuses a cookie-authenticated mutation from the ESDMS origin (403)" \
  '[[ $("${C[@]}" -o /dev/null -w "%{http_code}" -X POST -H "Origin: $APP" "$P/auth/logout") == 403 ]]'
check "Permit refuses a mutation without Origin/Referer (403)" \
  '[[ $("${C[@]}" -o /dev/null -w "%{http_code}" -X POST "$P/auth/logout") == 403 ]]'
check "Permit Dropbox OAuth callback needs a session (anonymous: 401)" \
  '[[ $(curl -s -o /dev/null -w "%{http_code}" --resolve permit-api.eset.localhost:4102:127.0.0.1 "$P/cms/dropbox/callback?state=x&code=y") == 401 ]]'
echo "== CMS / PWA public branding with no CMS branding and no storage configured"
code() { curl -s -o /dev/null -w "%{http_code}" --resolve api.eset.localhost:4101:127.0.0.1 --resolve permit-api.eset.localhost:4102:127.0.0.1 "$1"; }
body() { curl -s --resolve api.eset.localhost:4101:127.0.0.1 --resolve permit-api.eset.localhost:4102:127.0.0.1 "$1"; }
check "ESDMS public branding and manifest answer (200) without CMS branding" \
  '[[ $(code $E/cms/branding/public) == 200 && $(code $E/cms/branding/manifest.webmanifest) == 200 ]]'
check "ESDMS: no uploaded logo -> the bundled default logo (ETag default); no icon -> 404, frontend keeps bundled icons" \
  '[[ $(code $E/cms/branding/logo) == 200 && "$(curl -s -D - -o /dev/null --resolve api.eset.localhost:4101:127.0.0.1 $E/cms/branding/logo | tr -d "\r" | grep -i "^etag:")" =~ \"default\" && $(code $E/cms/branding/app-icon/192) == 404 ]]'
check "Permit public branding and manifest answer (200) with Dropbox unconfigured" \
  '[[ $(code $P/branding/public) == 200 && $(code $P/branding/manifest.webmanifest) == 200 ]]'
check "Permit: no web logo/icon -> 404 (bundled fallback), never 500" \
  '[[ $(code $P/branding/web-logo) == 404 && $(code $P/branding/icon/192) == 404 && $(code $P/branding/icon/7) == 404 ]]'
check "Permit manifest falls back to the bundled icons" '[[ "$(body $P/branding/manifest.webmanifest)" =~ \"icons\" ]]'
check "sign-in worked above with storage/Dropbox unconfigured (auth does not depend on branding)" '[[ -n "$pc" && -n "$ec" ]]'
[[ $FAILED == 0 ]] && echo "Topology checks passed." || { echo "Topology checks FAILED"; exit 1; }
