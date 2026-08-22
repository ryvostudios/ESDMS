/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

// RLS is a database-level guardrail for every table in the ESDMS public
// schema. The backend still owns application authentication, authorization,
// site isolation, and workflow checks; RLS prevents Supabase's browser-facing
// roles from acquiring direct table access and requires every runtime database
// role to be provisioned deliberately after migrations.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.sql(`
    ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.gate_pass_audit_log ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.gate_pass_files ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.gate_pass_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.gate_pass_number_counters ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.gate_passes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.pgmigrations ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
  `);

  // Supabase defines anon/authenticated; ordinary local PostgreSQL does not.
  // Guard every reference so the same migration remains portable. Default
  // privilege changes apply to objects subsequently created by the migration
  // owner, preventing future ESDMS tables/sequences from silently inheriting
  // browser-role access.
  pgm.sql(`
    DO $security$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM anon';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon';
      END IF;

      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated';
        EXECUTE 'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM authenticated';
        EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated';
      END IF;
    END
    $security$;
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  // The migration cannot know which browser-role grants or RLS settings were
  // safe before it ran. Restoring privileges or disabling RLS would therefore
  // be an unsafe guess. Any relaxation must be an explicit, separately
  // reviewed forward migration with a known target state.
  pgm.sql(`
    DO $security$
    BEGIN
      RAISE EXCEPTION 'database-runtime-security-boundary is intentionally irreversible: do not disable RLS or restore browser-role privileges automatically; use a new reviewed migration';
    END
    $security$;
  `);
};
