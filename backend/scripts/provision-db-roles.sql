-- Creates (or updates) a restricted runtime role for the API process to
-- connect as (DATABASE_URL) — separate from the owner role that runs
-- migrations (MIGRATION_DATABASE_URL). See docs/SECURITY.md §8.2 and
-- docs/DECISIONS.md ("Database Privilege Boundary and Verified TLS").
--
-- Run once per environment, connected AS THE OWNER/MIGRATION role, after
-- migrations have already created the schema:
--   psql "$MIGRATION_DATABASE_URL" -f scripts/provision-db-roles.sql
--
-- Edit the password below before running.

-- Postgres grants CREATE on the "public" schema to the PUBLIC pseudo-role
-- by default (on PG < 15) — every role, including esdms_runtime below, has
-- schema-object-creation rights it never needed until this is revoked at
-- the PUBLIC level. Revoking CREATE from esdms_runtime alone (further
-- down) is not enough on its own: a role's effective privileges are the
-- union of what's granted to it directly AND to PUBLIC, so PUBLIC's own
-- grant would still apply regardless.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esdms_runtime') THEN
    CREATE ROLE esdms_runtime LOGIN PASSWORD 'CHANGE_ME_STRONG_PASSWORD';
  END IF;
END
$$;

-- Explicit, even though these are the defaults for a role created without
-- these attributes — this is the actual security property being asserted.
ALTER ROLE esdms_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

GRANT USAGE ON SCHEMA public TO esdms_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO esdms_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO esdms_runtime;

-- Covers any table/sequence a future migration creates, without needing to
-- re-run this script after every migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO esdms_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO esdms_runtime;

-- Defense in depth: explicit even after the PUBLIC-level revoke above —
-- this role must never be able to alter schema under any path.
REVOKE CREATE ON SCHEMA public FROM esdms_runtime;

-- After running this, set the production DATABASE_URL to use this role
-- (esdms_runtime) and its password, while MIGRATION_DATABASE_URL keeps
-- using the owner role for all future `npm run migrate:up:prod` runs.

-- --------------------------------------------------------------------
-- Verification — confirms what was actually granted, not just what this
-- script intended. Run standalone any time with:
--   psql "$MIGRATION_DATABASE_URL" \
--     -c "\df" -c "select ..." -- or just re-run this whole file; the
--     grants above are idempotent (GRANT/REVOKE, not INSERT).
-- --------------------------------------------------------------------

-- Role attributes: every column here must read false/f except rolcanlogin.
SELECT
  rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
FROM pg_roles
WHERE rolname = 'esdms_runtime';

-- Table-level effective privileges: expect SELECT/INSERT/UPDATE/DELETE
-- only — no TRUNCATE, REFERENCES, or TRIGGER, and no rows at all for a
-- role that has DDL rights, since DDL isn't a table-level privilege.
SELECT table_name, privilege_type
FROM information_schema.role_table_grants
WHERE grantee = 'esdms_runtime'
ORDER BY table_name, privilege_type;

-- Schema-level: expect has_usage = true, has_create = false.
SELECT
  has_schema_privilege('esdms_runtime', 'public', 'USAGE') AS has_usage,
  has_schema_privilege('esdms_runtime', 'public', 'CREATE') AS has_create;
