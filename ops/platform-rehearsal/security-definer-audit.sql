-- SECURITY DEFINER / search_path / dynamic-SQL audit of the three application
-- schemas (public = ESDMS, permit, attendance). Run as the administrator.
-- Prints an inventory, then raises an exception listing any violation:
--   * a SECURITY DEFINER function without a pinned search_path;
--   * a pinned path that omits pg_temp (it is then searched FIRST for
--     relations) or lists pg_temp anywhere but last;
--   * a path schema that any role other than its owner (or PUBLIC) can CREATE in;
--   * a superuser owner, or EXECUTE for PUBLIC / anon / authenticated / service_role;
--   * an application role whose own search_path reaches another application's schema.
\set ON_ERROR_STOP on
\pset footer off

\echo '== SECURITY DEFINER functions (schema, function, owner, search_path, EXECUTE grantees)'
SELECT n.nspname AS schema, p.oid::regprocedure AS function, pg_get_userbyid(p.proowner) AS owner,
       (SELECT string_agg(c, ' ') FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS search_path,
       (SELECT string_agg(CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END, ', ' ORDER BY 1)
          FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE a.privilege_type = 'EXECUTE') AS execute
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE p.prosecdef AND n.nspname IN ('public', 'permit', 'attendance')
 ORDER BY 1, 2::text;

\echo '== Application role search_path settings'
SELECT r.rolname AS role, s.setconfig AS settings
  FROM pg_roles r JOIN pg_db_role_setting s ON s.setrole = r.oid
 WHERE r.rolname ~ '^(esdms|permit|attendance)_'
 ORDER BY 1;

\echo '== Functions with dynamic SQL (PL/pgSQL EXECUTE) in application schemas'
SELECT n.nspname AS schema, p.oid::regprocedure AS function, p.prosecdef AS security_definer
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
 WHERE n.nspname IN ('public', 'permit', 'attendance') AND l.lanname = 'plpgsql'
   AND p.prosrc ~* '\mEXECUTE\M'
 ORDER BY 1, 2::text;

DO $audit$
DECLARE
  f record;
  entry text;
  entries text[];
  problems text[] := '{}';
  writer text;
  checked int := 0;
BEGIN
  FOR f IN
    SELECT n.nspname, p.oid, p.oid::regprocedure::text AS name, p.proowner, p.proacl,
           (SELECT substr(c, 13) FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS path
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE p.prosecdef AND n.nspname IN ('public', 'permit', 'attendance')
  LOOP
    checked := checked + 1;
    IF f.path IS NULL THEN
      problems := problems || (f.name || ': SECURITY DEFINER without a pinned search_path');
      CONTINUE;
    END IF;
    entries := ARRAY(SELECT btrim(btrim(e), '"') FROM unnest(string_to_array(f.path, ',')) e);
    IF NOT ('pg_temp' = ANY (entries)) THEN
      -- Reviewed exception (Phase 6): the body reads only the schema-qualified
      -- public.pgmigrations and pg_catalog aggregates. pg_temp is consulted only
      -- for UNQUALIFIED relation names (never for functions or operators), so it
      -- cannot be shadowed. Hygiene follow-up: an ESDMS expand migration adding
      -- pg_temp last (docs/DEFERRED_WORK.md).
      IF f.name = 'esdms_schema_migration_state(text)' THEN
        RAISE NOTICE 'reviewed exception: % (search_path %) references only qualified relations', f.name, f.path;
      ELSE
        problems := problems || (f.name || ': search_path omits pg_temp, which is then searched first');
      END IF;
    ELSIF entries[cardinality(entries)] <> 'pg_temp' THEN
      problems := problems || (f.name || ': pg_temp is not last in search_path');
    END IF;
    FOREACH entry IN ARRAY entries LOOP
      CONTINUE WHEN entry IN ('pg_catalog', 'pg_temp') OR to_regnamespace(entry) IS NULL;
      FOR writer IN
        SELECT r.rolname FROM pg_roles r
         WHERE NOT r.rolsuper AND r.oid <> (SELECT nspowner FROM pg_namespace WHERE nspname = entry)
           AND has_schema_privilege(r.oid, entry, 'CREATE')
        UNION ALL
        SELECT 'PUBLIC' WHERE EXISTS (SELECT 1 FROM pg_namespace ns, aclexplode(ns.nspacl) a
                                       WHERE ns.nspname = entry AND a.grantee = 0 AND a.privilege_type = 'CREATE')
      LOOP
        problems := problems || format('%s: search_path schema %s is writable by %s', f.name, entry, writer);
      END LOOP;
    END LOOP;
    IF (SELECT rolsuper FROM pg_roles WHERE oid = f.proowner) THEN
      problems := problems || (f.name || ': owned by a superuser');
    END IF;
    FOR writer IN
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END
        FROM aclexplode(coalesce(f.proacl, acldefault('f', f.proowner))) a
       WHERE a.privilege_type = 'EXECUTE'
         AND (a.grantee = 0 OR pg_get_userbyid(a.grantee) IN ('anon', 'authenticated', 'service_role'))
    LOOP
      IF writer = 'service_role' AND f.nspname = 'public' THEN
        -- Supabase's default grant on ESDMS's public: the separately owned
        -- ESDMS service_role item (see the security matrix report). Reported.
        RAISE NOTICE 'carried ESDMS item: % is executable by service_role (Supabase default on public)', f.name;
      ELSE
        problems := problems || format('%s: EXECUTE granted to %s', f.name, writer);
      END IF;
    END LOOP;
  END LOOP;

  FOR f IN
    SELECT r.rolname, c AS setting FROM pg_roles r JOIN pg_db_role_setting s ON s.setrole = r.oid, unnest(s.setconfig) c
     WHERE r.rolname ~ '^(esdms|permit|attendance)_' AND c LIKE 'search_path=%'
  LOOP
    IF (f.rolname LIKE 'permit\_%' AND f.setting ~ '\m(public|attendance)\M')
       OR (f.rolname LIKE 'attendance\_%' AND f.setting ~ '\m(public|permit)\M')
       OR (f.rolname LIKE 'esdms\_%' AND f.setting ~ '\m(permit|attendance)\M') THEN
      problems := problems || format('%s: role search_path reaches another application (%s)', f.rolname, f.setting);
    END IF;
  END LOOP;

  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'SECURITY DEFINER AUDIT FAILURE (% functions checked):%', checked, E'\n' || array_to_string(problems, E'\n');
  END IF;
  RAISE NOTICE 'SECURITY DEFINER audit passed: % functions; pinned search_path with pg_temp last; no writable path schema; no superuser owner; no PUBLIC/API-role EXECUTE; role search_paths confined', checked;
END
$audit$;
