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

-- Defense in depth: this role must never be able to alter schema, even
-- though it was never granted CREATE explicitly above.
REVOKE CREATE ON SCHEMA public FROM esdms_runtime;

-- After running this, set the production DATABASE_URL to use this role
-- (esdms_runtime) and its password, while MIGRATION_DATABASE_URL keeps
-- using the owner role for all future `npm run migrate:up` runs.
