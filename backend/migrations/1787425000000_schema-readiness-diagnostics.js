export const shorthands = undefined;

export async function up(pgm) {
  // The runtime role intentionally cannot read pgmigrations. Expose only the
  // non-sensitive aggregate needed for readiness through one narrowly granted
  // SECURITY DEFINER function; no migration SQL or connection data is returned.
  pgm.sql(`
    CREATE FUNCTION esdms_schema_migration_state(expected_name text)
    RETURNS TABLE(applied_count integer, latest_applied text, expected_applied boolean)
    LANGUAGE sql
    STABLE
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $function$
      SELECT
        COUNT(*)::integer,
        (ARRAY_AGG(m.name ORDER BY m.id DESC))[1],
        COALESCE(BOOL_OR(m.name = expected_name), false)
      FROM public.pgmigrations m;
    $function$;

    REVOKE ALL ON FUNCTION esdms_schema_migration_state(text) FROM PUBLIC;

    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esdms_runtime') THEN
        GRANT EXECUTE ON FUNCTION esdms_schema_migration_state(text) TO esdms_runtime;
      END IF;
    END
    $block$;
  `);
}

export async function down(pgm) {
  pgm.sql("DROP FUNCTION IF EXISTS esdms_schema_migration_state(text);");
}
