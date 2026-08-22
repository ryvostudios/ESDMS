/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

// PostgreSQL gives PUBLIC EXECUTE on newly created functions by default.
// ESDMS functions in public are trigger implementation details, not browser
// or runtime APIs, so both existing functions and migration-owner defaults
// must be hardened explicitly.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

    -- The built-in PUBLIC function default is global. A per-schema REVOKE
    -- cannot subtract a global default, so revoke globally first; the scoped
    -- revoke also removes any explicit public-schema default grant.
    ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
  `);

  // Supabase defines anon/authenticated; ordinary local PostgreSQL does not.
  // These statements affect only current objects and defaults owned by the
  // migration role executing this migration. supabase_admin defaults are
  // owner-specific and deliberately remain untouched.
  pgm.sql(`
    DO $function_security$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon';
      END IF;

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM authenticated';
      END IF;
    END
    $function_security$;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  // The migration cannot reconstruct which function grants/defaults were
  // previously intentional. Restoring PUBLIC or browser-role EXECUTE would
  // silently reopen a database API, so reversal requires a reviewed forward
  // migration with an explicit target state.
  pgm.sql(`
    DO $function_security$
    BEGIN
      RAISE EXCEPTION 'public-function-execution-boundary is intentionally irreversible: do not restore function EXECUTE defaults automatically; use a new reviewed migration';
    END
    $function_security$;
  `);
};
