-- Fingerprint of the whole shared database for backup/restore comparison:
-- catalog (schemas, relations, columns, constraints, indexes, functions,
-- triggers, policies, grants, role attributes and memberships - never
-- passwords) and, per table of public / permit / attendance, the row count
-- and an order-independent content digest; sequence positions.
-- Run with PGTZ=UTC so timestamps render identically in both databases.
--
-- Normalized, because pg_dump/pg_restore re-parse them without changing
-- meaning: ACLs are compared as EFFECTIVE privileges (a NULL ACL is its
-- acldefault), and constraint text without the casts and redundant
-- parentheses pg_restore re-parses (a CHECK written (ARRAY[..])::text[] is
-- restored as ARRAY[(..)::text, ..]); boolean grouping parentheses are
-- kept. A different value, column, table, grouping or privilege still shows.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
SET TIME ZONE 'UTC';
SET search_path = pg_catalog;
WITH ns AS (
  SELECT oid, nspname FROM pg_namespace
   WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\_toast%' AND nspname NOT LIKE 'pg\_temp%'
)
SELECT line FROM (
  SELECT format('schema %s owner=%s acl=%s', nspname, pg_get_userbyid(n.nspowner), coalesce(n.nspacl, acldefault('n', n.nspowner)))
    FROM pg_namespace n WHERE n.oid IN (SELECT oid FROM ns)
  UNION ALL
  SELECT format('rel %s.%s kind=%s owner=%s acl=%s rls=%s force=%s', ns.nspname, c.relname, c.relkind,
                pg_get_userbyid(c.relowner), coalesce(c.relacl, acldefault((CASE c.relkind WHEN 'S' THEN 's' ELSE 'r' END)::"char", c.relowner)),
                c.relrowsecurity, c.relforcerowsecurity)
    FROM pg_class c JOIN ns ON ns.oid = c.relnamespace
  UNION ALL
  SELECT format('col %s.%s.%s %s notnull=%s default=%s acl=%s', ns.nspname, c.relname, a.attname,
                format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attacl)
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('constraint %s.%s %s: %s', ns.nspname, c.relname, k.conname,
                regexp_replace(regexp_replace(regexp_replace(pg_get_constraintdef(k.oid),
                  $re$::(character varying|text)(\[\])?$re$, '', 'g'),  -- casts pg_restore re-adds or drops
                  $re$\(('(?:[^']|'')*')\)$re$, '\1', 'g'),              -- ('X') -> 'X'
                  $re$\(\(ARRAY\[([^]]*)\]\)\)$re$, '(ARRAY[\1])', 'g')) -- ((ARRAY[..])) -> (ARRAY[..]); grouping kept
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN ns ON ns.oid = c.relnamespace
  UNION ALL
  SELECT format('index %s', pg_get_indexdef(i.indexrelid))
    FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN ns ON ns.oid = c.relnamespace
  UNION ALL
  SELECT format('function %s owner=%s acl=%s secdef=%s config=%s body=%s', p.oid::regprocedure,
                pg_get_userbyid(p.proowner), coalesce(p.proacl, acldefault('f', p.proowner)), p.prosecdef, p.proconfig, md5(p.prosrc))
    FROM pg_proc p JOIN ns ON ns.oid = p.pronamespace
  UNION ALL
  SELECT format('trigger %s enabled=%s', pg_get_triggerdef(t.oid), t.tgenabled)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN ns ON ns.oid = c.relnamespace
   WHERE NOT t.tgisinternal
  UNION ALL
  SELECT format('policy %s.%s %s cmd=%s roles=%s using=%s check=%s', ns.nspname, c.relname, p.polname, p.polcmd,
                p.polroles::regrole[], pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
    FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid JOIN ns ON ns.oid = c.relnamespace
  UNION ALL
  SELECT format('default-acl %s in %s: %s', pg_get_userbyid(d.defaclrole), d.defaclnamespace::regnamespace, d.defaclacl)
    FROM pg_default_acl d
  UNION ALL
  SELECT format('role %s super=%s bypassrls=%s createdb=%s createrole=%s inherit=%s login=%s connlimit=%s config=%s',
                r.rolname, r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolinherit, r.rolcanlogin,
                r.rolconnlimit, (SELECT array_agg(s.setconfig) FROM pg_db_role_setting s WHERE s.setrole = r.oid))
    FROM pg_roles r WHERE r.rolname NOT LIKE 'pg\_%' AND r.rolname <> current_user
  UNION ALL
  SELECT format('member %s in %s', pg_get_userbyid(m.member), pg_get_userbyid(m.roleid)) FROM pg_auth_members m
   WHERE pg_get_userbyid(m.roleid) NOT LIKE 'pg\_%'
  UNION ALL
  SELECT format('database-acl %s', a) FROM pg_database d, unnest(d.datacl) a WHERE d.datname = current_database()
  UNION ALL
  SELECT format('database-setting %s', c) FROM pg_db_role_setting s, unnest(s.setconfig) c
   WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
) inventory (line)
ORDER BY line COLLATE "C";

SELECT line FROM (
  SELECT format('rows %s.%s count=%s md5=%s', n.nspname, c.relname,
                (xpath('/row/n/text()', query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text,
                (xpath('/row/h/text()', query_to_xml(format(
                   'SELECT md5(coalesce(string_agg(t::text, E''\n'' ORDER BY t::text), '''')) AS h FROM %I.%I t', n.nspname, c.relname), false, true, '')))[1]::text)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'p') AND n.nspname IN ('public', 'permit', 'attendance')
) data (line)
ORDER BY line COLLATE "C";

SELECT line FROM (
  SELECT format('sequence %s.%s last=%s', schemaname, sequencename, last_value)
    FROM pg_sequences WHERE schemaname IN ('public', 'permit', 'attendance')
) sequences (line)
ORDER BY line COLLATE "C";
