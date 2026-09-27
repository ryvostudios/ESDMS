-- Cross-application security matrix for ONE role. Run while connected AS the
-- role (real login), or for a NOLOGIN Supabase role from the administrator
-- with `SET ROLE <role>` first. Every check runs in a transaction that is
-- rolled back; nothing is left behind.
--
--   psql -v own=public|permit|attendance|none -v kind=runtime|owner -f security-matrix.sql
--
-- `own` is the application schema this role serves (none for the Supabase
-- API roles). `kind=owner` is an application's migration owner: DDL in its
-- own schema is its job, so only the cross-application checks apply.
-- The role must be refused (42501) for every read, write, DDL,
-- TRUNCATE and DROP on every table of every OTHER application schema, and
-- for DDL, CREATE SCHEMA, CREATE ROLE and SET ROLE anywhere. It must carry
-- no elevated attribute or membership, and hold EXECUTE on no function of
-- another application's schema.
\set ON_ERROR_STOP on
BEGIN;
SELECT set_config('matrix.own', :'own', true) AS configured, set_config('matrix.kind', :'kind', true) AS kind \gset matrix_
DO $matrix$
DECLARE
  own text := current_setting('matrix.own');
  kind text := current_setting('matrix.kind');
  target record;
  first_column text;
  attempt text;
  problems text[] := '{}';
  foreign_tables int := 0;
  own_tables int := 0;
  fn text;
  other text;
BEGIN
  IF own NOT IN ('public', 'permit', 'attendance', 'none') THEN
    RAISE EXCEPTION 'own must be public, permit, attendance or none';
  END IF;

  -- 1. Every table of every other application schema: all operations refused.
  FOR target IN
    SELECT n.nspname, c.relname, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'permit', 'attendance') AND n.nspname <> own
     ORDER BY 1, 2
  LOOP
    foreign_tables := foreign_tables + 1;
    SELECT quote_ident(a.attname) INTO first_column FROM pg_attribute a
     WHERE a.attrelid = target.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 1;
    FOREACH attempt IN ARRAY ARRAY[
      format('SELECT * FROM %I.%I LIMIT 1', target.nspname, target.relname),
      format('INSERT INTO %I.%I DEFAULT VALUES', target.nspname, target.relname),
      format('UPDATE %I.%I SET %s = %s', target.nspname, target.relname, first_column, first_column),
      format('DELETE FROM %I.%I', target.nspname, target.relname),
      format('TRUNCATE %I.%I', target.nspname, target.relname),
      format('ALTER TABLE %I.%I ADD COLUMN matrix_probe int', target.nspname, target.relname),
      format('DROP TABLE %I.%I', target.nspname, target.relname)
    ] LOOP
      BEGIN
        EXECUTE attempt;
        problems := problems || ('ALLOWED: ' || attempt);
      EXCEPTION
        WHEN insufficient_privilege THEN NULL;
        WHEN OTHERS THEN problems := problems || (SQLSTATE || ' (not 42501): ' || attempt);
      END;
    END LOOP;
  END LOOP;

  -- 2. Its own schema (runtime roles): data access by grant only; no DDL, no TRUNCATE, no DROP.
  IF own <> 'none' AND kind = 'runtime' THEN
    FOR target IN
      SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r', 'p') AND n.nspname = own ORDER BY 2
    LOOP
      own_tables := own_tables + 1;
      FOREACH attempt IN ARRAY ARRAY[
        format('ALTER TABLE %I.%I ADD COLUMN matrix_probe int', target.nspname, target.relname),
        format('DROP TABLE %I.%I', target.nspname, target.relname),
        format('TRUNCATE %I.%I', target.nspname, target.relname)
      ] LOOP
        BEGIN
          EXECUTE attempt;
          problems := problems || ('ALLOWED in own schema: ' || attempt);
        EXCEPTION
          WHEN insufficient_privilege THEN NULL;
          WHEN OTHERS THEN problems := problems || (SQLSTATE || ' (not 42501): ' || attempt);
        END;
      END LOOP;
    END LOOP;
  END IF;

  -- 3. No creation anywhere, no new schemas or roles.
  FOR other IN SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\_%' AND nspname <> 'information_schema'
                  AND NOT (kind = 'owner' AND nspname = own) LOOP
    BEGIN
      EXECUTE format('CREATE TABLE %I.matrix_probe (id int)', other);
      problems := problems || ('ALLOWED: CREATE TABLE in ' || other);
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  FOREACH attempt IN ARRAY ARRAY['CREATE SCHEMA matrix_probe', 'CREATE ROLE matrix_probe'] LOOP
    BEGIN
      EXECUTE attempt;
      problems := problems || ('ALLOWED: ' || attempt);
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  -- 4. No SET ROLE into any other role (migrators, privileged, owners, Supabase roles).
  --    SET ROLE is judged by the SESSION user, so this and the attribute check
  --    apply to real logins only; an impersonated NOLOGIN API role is reported.
  IF session_user <> current_user THEN
    RAISE NOTICE '% is NOLOGIN (impersonated): attributes super=% bypassrls=% (holds no application-schema privilege to bypass)',
      current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user), (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user);
  ELSE
  FOR other IN SELECT rolname FROM pg_roles
                WHERE rolname <> current_user AND rolname NOT LIKE 'pg\_%'
                  AND rolname IN ('postgres', 'esdms_owner', 'esdms_runtime', 'permit_migrator', 'permit_runtime',
                                  'permit_privileged', 'attendance_migrator', 'attendance_runtime',
                                  'anon', 'authenticated', 'service_role', 'app_runtime', 'privileged_runtime') LOOP
    BEGIN
      EXECUTE format('SET ROLE %I', other);
      EXECUTE 'RESET ROLE';
      problems := problems || ('ALLOWED: SET ROLE ' || other);
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;

  -- 5. Attributes: no superuser, BYPASSRLS, CREATEDB (so CREATE DATABASE is refused; it cannot run inside this
  --    rolled-back transaction), CREATEROLE, replication, or membership.
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = current_user
              AND (r.rolsuper OR r.rolbypassrls OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
                   OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid))) THEN
    problems := problems || 'has an elevated attribute or a role membership'::text;
  END IF;
  END IF;

  -- 6. EXECUTE on no function of another application schema.
  FOR fn IN SELECT p.oid::regprocedure::text FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname IN ('public', 'permit', 'attendance') AND n.nspname <> own
               AND has_function_privilege(p.oid, 'EXECUTE') LOOP
    problems := problems || ('EXECUTE allowed on ' || fn);
  END LOOP;

  FOR other IN SELECT unnest(ARRAY['public', 'permit', 'attendance']) EXCEPT SELECT own LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = to_regnamespace(other) AND relkind IN ('r', 'p')) THEN
      problems := problems || format('schema %s has no tables: the matrix would prove nothing', other);
    END IF;
  END LOOP;
  IF cardinality(problems) > 0 THEN
    RAISE EXCEPTION 'SECURITY MATRIX FAILURE for % (own=%, %): %', current_user, own, kind, array_to_string(problems, E'\n');
  END IF;
  RAISE NOTICE 'PASS %: denied on % foreign tables x7 ops; no DDL/TRUNCATE/DROP on % own tables; no CREATE in any schema, CREATE SCHEMA/ROLE, SET ROLE or foreign EXECUTE; no elevated attributes',
    rpad(current_user, 20), foreign_tables, own_tables;
END
$matrix$;
ROLLBACK;
