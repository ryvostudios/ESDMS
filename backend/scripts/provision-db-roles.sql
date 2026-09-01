\set ON_ERROR_STOP on
\set ECHO none

-- Provisions the least-privilege database login used by the running API
-- (DATABASE_URL). Run this only as the migration/schema-owner role, after all
-- migrations have completed. The migration credential is never used by the
-- running API.
--
-- Production invocation (the password is read without terminal echo and is
-- never placed in this file or in the psql command line):
--
--   read -rs ESDMS_RUNTIME_PASSWORD
--   export ESDMS_RUNTIME_PASSWORD
--   psql --no-psqlrc "$MIGRATION_DATABASE_URL" -f scripts/provision-db-roles.sql
--   unset ESDMS_RUNTIME_PASSWORD
--
-- --no-psqlrc is part of the secret-handling boundary: a user's .psqlrc is
-- executed before this file and could otherwise inspect environment variables.
-- The script-level ECHO setting above is deliberately applied before \getenv so
-- command-line query echoing cannot print an interpolated role password.
--
-- Re-run after every reviewed migration that adds a table. Future tables do
-- not receive automatic runtime grants or policies.

\getenv runtime_password ESDMS_RUNTIME_PASSWORD
\if :{?runtime_password}
\else
  \warn 'ERROR: ESDMS_RUNTIME_PASSWORD is required.'
  DO $abort$ BEGIN RAISE EXCEPTION 'ESDMS_RUNTIME_PASSWORD is required'; END $abort$;
\endif

-- Use an extended-query parameter for validation so the password is never
-- interpolated into a SELECT statement or exposed by statement logging.
SELECT length($1) >= 16 AS runtime_password_valid
\bind :'runtime_password'
\gset
\if :runtime_password_valid
\else
  \warn 'ERROR: ESDMS_RUNTIME_PASSWORD must be at least 16 characters.'
  DO $abort$ BEGIN RAISE EXCEPTION 'ESDMS_RUNTIME_PASSWORD is too short'; END $abort$;
\endif

BEGIN;

-- Supabase does not permit a non-superuser provisioning connection to issue
-- ALTER ROLE ... NOSUPERUSER/NOBYPASSRLS against roles carrying protected
-- attributes. Verify the invariant instead. An existing unsafe or NOLOGIN
-- role is rejected before its password or any grants are changed.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'esdms_runtime') AS runtime_role_exists
\gset

\if :runtime_role_exists
  SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
         AND rolcanlogin AS existing_runtime_role_safe
  FROM pg_roles
  WHERE rolname = 'esdms_runtime'
  \gset
  \if :existing_runtime_role_safe
    ALTER ROLE esdms_runtime PASSWORD :'runtime_password';
  \else
    \warn 'ERROR: existing esdms_runtime has a dangerous role attribute or cannot log in; refusing to alter it.'
    DO $abort$ BEGIN RAISE EXCEPTION 'unsafe existing esdms_runtime role attributes'; END $abort$;
  \endif
\else
  CREATE ROLE esdms_runtime LOGIN PASSWORD :'runtime_password';
\endif

-- Re-verify after either creation or password rotation. No BYPASSRLS or other
-- elevated role attribute is ever granted by this script.
SELECT NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
       AND rolcanlogin AS runtime_role_safe
FROM pg_roles
WHERE rolname = 'esdms_runtime'
\gset
\if :runtime_role_safe
\else
  \warn 'ERROR: esdms_runtime failed the required role-attribute invariant.'
  DO $abort$ BEGIN RAISE EXCEPTION 'esdms_runtime role-attribute verification failed'; END $abort$;
\endif

-- Schema boundary. Revoking PUBLIC is necessary because effective privileges
-- are the union of direct grants and grants inherited from PUBLIC.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO esdms_runtime;
REVOKE CREATE ON SCHEMA public FROM esdms_runtime;

-- Remove every legacy broad grant first, including the old pgmigrations and
-- sequence access. Also remove the old migration-owner default privileges so
-- future modules never become runtime-accessible without explicit review.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM esdms_runtime;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM esdms_runtime;
ALTER DEFAULT PRIVILEGES
  REVOKE ALL PRIVILEGES ON TABLES FROM esdms_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM esdms_runtime;
ALTER DEFAULT PRIVILEGES
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM esdms_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM esdms_runtime;

-- The current schema uses UUIDs and an ordinary counter table, so the API
-- needs no sequence privileges. These existing application tables receive
-- DML access; public.pgmigrations is deliberately excluded.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.company_items,
  public.department_material_catalog,
  public.carry_forward_allocations,
  public.delivery_challan_lines,
  public.delivery_challans,
  public.departments,
  public.drivers,
  public.document_number_counters,
  public.document_number_settings,
  public.employee_business_history,
  public.employee_compensation_records,
  public.employee_contract_number_counters,
  public.employee_contracts,
  public.employee_custom_field_values,
  public.employee_custom_fields,
  public.employee_document_requests,
  public.employee_document_types,
  public.employee_documents,
  public.employee_emergency_contacts,
  public.employee_personal_details,
  public.employee_profile_photos,
  public.employee_profile_sections,
  public.employee_rotation_ledger,
  public.employees,
  public.employment_assignments,
  public.employment_types,
  public.gate_pass_audit_log,
  public.gate_pass_files,
  public.gate_pass_items,
  public.gate_pass_number_counters,
  public.gate_passes,
  public.governance_audit_log,
  public.ipo_lines,
  public.ipo_purchase_events,
  public.ipos,
  public.leave_requests,
  public.leave_types,
  public.material_demand_approvals,
  public.material_demand_audit_log,
  public.material_demand_lines,
  public.material_demand_pricing,
  public.material_demand_pricing_lines,
  public.material_demand_number_counters,
  public.material_demand_line_dispositions,
  public.material_demands,
  public.material_receipt_lines,
  public.material_receipts,
  public.notification_outbox,
  public.procurement_audit_log,
  public.procurement_documents,
  public.permissions,
  public.positions,
  public.role_permissions,
  public.roles,
  public.rotation_policies,
  public.sites,
  public.temporary_assignments,
  public.units_of_measure,
  public.user_permission_overrides,
  public.users,
  public.vehicles
TO esdms_runtime;

-- Capability definitions are migration-owned reference data. Runtime may
-- read them but never rewrite bundle membership. Assignment provenance is
-- append/remove only; there is no unaudited UPDATE path.
GRANT SELECT ON TABLE
  public.permission_bundles,
  public.permission_bundle_permissions
TO esdms_runtime;
GRANT SELECT, INSERT, DELETE ON TABLE
  public.user_permission_bundle_assignments
TO esdms_runtime;

-- Supabase browser-facing roles are not an application authorization path.
-- Guard role references so this script also runs on ordinary local Postgres.
SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') AS anon_exists
\gset
\if :anon_exists
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon;
  ALTER DEFAULT PRIVILEGES
    REVOKE ALL PRIVILEGES ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON TABLES FROM anon;
  ALTER DEFAULT PRIVILEGES
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM anon;
  ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM anon;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM anon;
\endif

SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') AS authenticated_exists
\gset
\if :authenticated_exists
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM authenticated;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM authenticated;
  REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM authenticated;
  ALTER DEFAULT PRIVILEGES
    REVOKE ALL PRIVILEGES ON TABLES FROM authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON TABLES FROM authenticated;
  ALTER DEFAULT PRIVILEGES
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE ALL PRIVILEGES ON SEQUENCES FROM authenticated;
  ALTER DEFAULT PRIVILEGES
    REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    REVOKE EXECUTE ON FUNCTIONS FROM authenticated;
\endif

-- Functions in public are trigger implementation details, not an application
-- authorization surface. PostgreSQL's built-in PUBLIC EXECUTE default is
-- global, and per-schema defaults are additive, so revoke both the global
-- default and any explicit public-schema grant owned by this migration role.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM esdms_runtime;
ALTER DEFAULT PRIVILEGES
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- The two runtime-callable public functions return only non-sensitive release
-- diagnostics. The provisioning version is deliberately replaced only by this
-- post-migration script: current migrations plus a stale/omitted provisioning
-- run must never satisfy readiness again.
GRANT EXECUTE ON FUNCTION public.esdms_schema_migration_state(text) TO esdms_runtime;
-- The stamp is DERIVED from the migration ledger at provisioning time rather
-- than hard-coded, for the same reason the table lists below are derived: a
-- literal that has to be hand-edited after every migration is a drift footgun,
-- and drift is exactly what this marker exists to detect. Baking in the level
-- actually present when provisioning ran makes the stale-provisioning case
-- impossible to fake -- you cannot stamp a level you did not migrate to.
DO $provision$
DECLARE
  provisioned_migration text;
BEGIN
  SELECT (ARRAY_AGG(m.name ORDER BY m.id DESC))[1]
    INTO provisioned_migration
    FROM public.pgmigrations m;

  IF provisioned_migration IS NULL THEN
    RAISE EXCEPTION 'No migrations have been applied. Run migrations before provisioning runtime privileges.';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.esdms_runtime_provisioning_version() '
    'RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = pg_catalog '
    'AS $body$ SELECT %L::text; $body$',
    provisioned_migration
  );
END
$provision$;
REVOKE ALL ON FUNCTION public.esdms_runtime_provisioning_version() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.esdms_runtime_provisioning_version() TO esdms_runtime;

-- Keep RLS enabled on every public ESDMS table. FORCE RLS is intentionally not
-- used: the migration owner must continue to run schema migrations, while the
-- non-owner runtime login remains subject to policy enforcement.
ALTER TABLE public.company_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.department_material_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.carry_forward_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_challan_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.delivery_challans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_number_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_business_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_compensation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_contract_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_contracts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_custom_field_values ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_custom_fields ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_document_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_document_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_emergency_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_personal_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profile_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_profile_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employee_rotation_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employment_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.employment_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_pass_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_pass_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_pass_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_pass_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gate_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.governance_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ipo_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ipo_purchase_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ipos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leave_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_pricing ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_pricing_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_number_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demand_line_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_demands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.material_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procurement_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permission_bundle_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pgmigrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rotation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.temporary_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.units_of_measure ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_permission_bundle_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;

-- Converge each application table to exactly one known runtime policy. Drop
-- and recreate is transactional and idempotent. pgmigrations intentionally has
-- no runtime policy and no runtime table privilege.
DO $policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'company_items',
    'department_material_catalog',
    'carry_forward_allocations',
    'delivery_challan_lines',
    'delivery_challans',
    'departments',
    'drivers',
    'document_number_counters',
    'document_number_settings',
    'employee_business_history',
    'employee_compensation_records',
    'employee_contract_number_counters',
    'employee_contracts',
    'employee_custom_field_values',
    'employee_custom_fields',
    'employee_document_requests',
    'employee_document_types',
    'employee_documents',
    'employee_emergency_contacts',
    'employee_personal_details',
    'employee_profile_photos',
    'employee_profile_sections',
    'employee_rotation_ledger',
    'employees',
    'employment_assignments',
    'employment_types',
    'gate_pass_audit_log',
    'gate_pass_files',
    'gate_pass_items',
    'gate_pass_number_counters',
    'gate_passes',
    'governance_audit_log',
    'ipo_lines',
    'ipo_purchase_events',
    'ipos',
    'leave_requests',
    'leave_types',
    'material_demand_approvals',
    'material_demand_audit_log',
    'material_demand_lines',
    'material_demand_pricing',
    'material_demand_pricing_lines',
    'material_demand_number_counters',
    'material_demand_line_dispositions',
    'material_demands',
    'material_receipt_lines',
    'material_receipts',
    'notification_outbox',
    'procurement_audit_log',
    'procurement_documents',
    'permissions',
    'permission_bundles',
    'permission_bundle_permissions',
    'positions',
    'role_permissions',
    'roles',
    'rotation_policies',
    'sites',
    'temporary_assignments',
    'units_of_measure',
    'user_permission_overrides',
    'user_permission_bundle_assignments',
    'users',
    'vehicles'
  ]
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS esdms_runtime_access ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY esdms_runtime_access ON public.%I FOR ALL TO esdms_runtime USING (true) WITH CHECK (true)',
      table_name
    );
  END LOOP;

  DROP POLICY IF EXISTS esdms_runtime_access ON public.pgmigrations;
END
$policies$;

-- -------------------------------------------------------------------------
-- Verification: display the effective boundary and fail the transaction if
-- any invariant differs. A failure rolls back password/grant/policy changes.
-- -------------------------------------------------------------------------

-- 1. Role attributes (all dangerous flags false; LOGIN true).
SELECT
  rolname,
  rolsuper,
  rolcreatedb,
  rolcreaterole,
  rolreplication,
  rolbypassrls,
  rolcanlogin
FROM pg_roles
WHERE rolname = 'esdms_runtime';

SELECT NOT EXISTS (
  SELECT 1
  FROM pg_auth_members m
  JOIN pg_roles member_role ON member_role.oid = m.member
  WHERE member_role.rolname = 'esdms_runtime'
) AS runtime_membership_boundary_valid
\gset
\if :runtime_membership_boundary_valid
\else
  \warn 'ERROR: esdms_runtime unexpectedly inherits another database role.'
  DO $abort$ BEGIN RAISE EXCEPTION 'esdms_runtime role membership verification failed'; END $abort$;
\endif

-- 2. Schema privileges (USAGE true; CREATE false).
SELECT
  has_schema_privilege('esdms_runtime', 'public', 'USAGE') AS has_usage,
  has_schema_privilege('esdms_runtime', 'public', 'CREATE') AS has_create;

SELECT
  has_schema_privilege('esdms_runtime', 'public', 'USAGE')
  AND NOT has_schema_privilege('esdms_runtime', 'public', 'CREATE') AS runtime_schema_boundary_valid
\gset
\if :runtime_schema_boundary_valid
\else
  \warn 'ERROR: esdms_runtime schema privilege verification failed.'
  DO $abort$ BEGIN RAISE EXCEPTION 'esdms_runtime schema privilege verification failed'; END $abort$;
\endif

-- 3. Effective runtime table privileges. The displayed rows are the direct
-- grants; the invariant below additionally checks effective privileges from
-- PUBLIC or role membership.
SELECT table_name, privilege_type
FROM information_schema.table_privileges
WHERE table_schema = 'public'
  AND grantee = 'esdms_runtime'
ORDER BY table_name, privilege_type;

WITH
expected_tables(table_name) AS (
  VALUES
    ('company_items'),
    ('department_material_catalog'),
    ('carry_forward_allocations'),
    ('delivery_challan_lines'),
    ('delivery_challans'),
    ('departments'),
    ('drivers'),
    ('document_number_counters'),
    ('document_number_settings'),
    ('employee_business_history'),
    ('employee_compensation_records'),
    ('employee_contract_number_counters'),
    ('employee_contracts'),
    ('employee_custom_field_values'),
    ('employee_custom_fields'),
    ('employee_document_requests'),
    ('employee_document_types'),
    ('employee_documents'),
    ('employee_emergency_contacts'),
    ('employee_personal_details'),
    ('employee_profile_photos'),
    ('employee_profile_sections'),
    ('employee_rotation_ledger'),
    ('employees'),
    ('employment_assignments'),
    ('employment_types'),
    ('gate_pass_audit_log'),
    ('gate_pass_files'),
    ('gate_pass_items'),
    ('gate_pass_number_counters'),
    ('gate_passes'),
    ('governance_audit_log'),
    ('ipo_lines'),
    ('ipo_purchase_events'),
    ('ipos'),
    ('leave_requests'),
    ('leave_types'),
    ('material_demand_approvals'),
    ('material_demand_audit_log'),
    ('material_demand_lines'),
    ('material_demand_pricing'),
    ('material_demand_pricing_lines'),
    ('material_demand_number_counters'),
    ('material_demand_line_dispositions'),
    ('material_demands'),
    ('material_receipt_lines'),
    ('material_receipts'),
    ('notification_outbox'),
    ('procurement_audit_log'),
    ('procurement_documents'),
    ('permissions'),
    ('positions'),
    ('role_permissions'),
    ('roles'),
    ('rotation_policies'),
    ('sites'),
    ('temporary_assignments'),
    ('units_of_measure'),
    ('user_permission_overrides'),
    ('users'),
    ('vehicles')
),
dml_privileges(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
),
expected_privileges(table_name, privilege_type) AS (
  SELECT e.table_name, p.privilege_type FROM expected_tables e CROSS JOIN dml_privileges p
  UNION ALL VALUES
    ('permission_bundles', 'SELECT'),
    ('permission_bundle_permissions', 'SELECT'),
    ('user_permission_bundle_assignments', 'SELECT'),
    ('user_permission_bundle_assignments', 'INSERT'),
    ('user_permission_bundle_assignments', 'DELETE')
),
all_table_privileges(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
),
public_relations AS (
  SELECT c.oid, c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM expected_privileges e
    JOIN public_relations r ON r.relname = e.table_name
    WHERE NOT has_table_privilege('esdms_runtime', r.oid, e.privilege_type)
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public_relations r
    CROSS JOIN all_table_privileges p
    WHERE has_table_privilege('esdms_runtime', r.oid, p.privilege_type)
      AND (
        NOT EXISTS (
          SELECT 1 FROM expected_privileges e
          WHERE e.table_name = r.relname AND e.privilege_type = p.privilege_type
        )
      )
  ) AS runtime_table_boundary_valid
\gset
\if :runtime_table_boundary_valid
\else
  \warn 'ERROR: esdms_runtime has missing or unintended public table privileges.'
  DO $abort$ BEGIN RAISE EXCEPTION 'esdms_runtime table privilege verification failed'; END $abort$;
\endif

-- 4. public.pgmigrations must have zero effective runtime privileges.
SELECT privilege_type,
       has_table_privilege('esdms_runtime', 'public.pgmigrations', privilege_type) AS granted
FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
  AS privileges(privilege_type)
ORDER BY privilege_type;

-- 5. RLS enabled on every table the runtime can reach, plus pgmigrations.
--
-- Derived from effective grants, never a repeated list. This block used to
-- name 63 tables by hand and assert `count(*) = 63`; the schema had grown to
-- 65 and the list had silently drifted, so `drivers` and `vehicles` were
-- excluded from the very assertion that claimed to cover everything.
--
-- The set is deliberately derived from GRANTS rather than from the policies
-- created above: a table the runtime can read but which was never given a
-- policy is exactly the dangerous case, and deriving from policies would
-- define that hole out of existence instead of catching it.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS force_rls
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND (
    c.relname = 'pgmigrations'
    OR has_table_privilege('esdms_runtime', c.oid, 'SELECT')
    OR has_table_privilege('esdms_runtime', c.oid, 'INSERT')
    OR has_table_privilege('esdms_runtime', c.oid, 'UPDATE')
    OR has_table_privilege('esdms_runtime', c.oid, 'DELETE')
  )
ORDER BY c.relname;

SELECT count(*) > 1 AND bool_and(c.relrowsecurity) AS all_expected_rls_enabled
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p')
  AND (
    c.relname = 'pgmigrations'
    OR has_table_privilege('esdms_runtime', c.oid, 'SELECT')
    OR has_table_privilege('esdms_runtime', c.oid, 'INSERT')
    OR has_table_privilege('esdms_runtime', c.oid, 'UPDATE')
    OR has_table_privilege('esdms_runtime', c.oid, 'DELETE')
  )
\gset
\if :all_expected_rls_enabled
\else
  \warn 'ERROR: RLS is not enabled on every runtime-accessible public table and pgmigrations.'
  DO $abort$ BEGIN RAISE EXCEPTION 'RLS verification failed'; END $abort$;
\endif

-- 6-7. Every runtime-accessible table has exactly the intended policy; none
-- exists on pgmigrations. This follows the effective allowlist established and
-- verified above instead of maintaining another copy of the table list.
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname = 'esdms_runtime_access'
ORDER BY tablename;

WITH runtime_tables(table_name) AS (
  SELECT DISTINCT c.relname
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(privilege_type)
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND c.relname <> 'pgmigrations'
    AND has_table_privilege('esdms_runtime', c.oid, p.privilege_type)
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM runtime_tables e
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_policies p
      WHERE p.schemaname = 'public'
        AND p.tablename = e.table_name
        AND p.policyname = 'esdms_runtime_access'
        AND p.permissive = 'PERMISSIVE'
        AND p.roles = ARRAY['esdms_runtime']::name[]
        AND p.cmd = 'ALL'
        AND p.qual = 'true'
        AND p.with_check = 'true'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'pgmigrations'
      AND policyname = 'esdms_runtime_access'
  ) AS runtime_policy_boundary_valid
\gset
\if :runtime_policy_boundary_valid
\else
  \warn 'ERROR: esdms_runtime_access policy verification failed.'
  DO $abort$ BEGIN RAISE EXCEPTION 'runtime RLS policy verification failed'; END $abort$;
\endif

-- The runtime role must never own schema/database objects. Ownership would
-- bypass ordinary grants and, for tables, RLS unless FORCE RLS were used.
SELECT NOT EXISTS (
  SELECT 1 FROM pg_class c
  WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'esdms_runtime')
  UNION ALL
  SELECT 1 FROM pg_proc p
  WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = 'esdms_runtime')
  UNION ALL
  SELECT 1 FROM pg_namespace n
  WHERE n.nspowner = (SELECT oid FROM pg_roles WHERE rolname = 'esdms_runtime')
  UNION ALL
  SELECT 1 FROM pg_database d
  WHERE d.datdba = (SELECT oid FROM pg_roles WHERE rolname = 'esdms_runtime')
) AS runtime_ownership_boundary_valid
\gset
\if :runtime_ownership_boundary_valid
\else
  \warn 'ERROR: esdms_runtime unexpectedly owns a database object.'
  DO $abort$ BEGIN RAISE EXCEPTION 'runtime ownership boundary verification failed'; END $abort$;
\endif

-- 8-9. Supabase browser roles, when present, have zero effective privileges
-- on public tables and sequences.
WITH browser_roles AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
),
public_relations AS (
  SELECT c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
),
table_privileges(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
)
SELECT r.rolname,
       count(*) FILTER (WHERE has_table_privilege(r.rolname, t.oid, p.privilege_type)) AS effective_table_privileges
FROM browser_roles r
CROSS JOIN public_relations t
CROSS JOIN table_privileges p
GROUP BY r.rolname
ORDER BY r.rolname;

WITH browser_roles AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
),
public_relations AS (
  SELECT c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
),
table_privileges(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')
)
SELECT NOT EXISTS (
  SELECT 1
  FROM browser_roles r
  CROSS JOIN public_relations t
  CROSS JOIN table_privileges p
  WHERE has_table_privilege(r.rolname, t.oid, p.privilege_type)
) AS browser_table_boundary_valid
\gset
\if :browser_table_boundary_valid
\else
  \warn 'ERROR: anon/authenticated retain effective privileges on public tables.'
  DO $abort$ BEGIN RAISE EXCEPTION 'browser-role table privilege verification failed'; END $abort$;
\endif

-- 10. Runtime and browser roles have no unintended public sequence access.
WITH checked_roles AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('esdms_runtime', 'anon', 'authenticated')
),
public_sequences AS (
  SELECT c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'S'
),
sequence_privileges(privilege_type) AS (
  VALUES ('USAGE'), ('SELECT'), ('UPDATE')
)
SELECT r.rolname,
       count(*) FILTER (WHERE has_sequence_privilege(r.rolname, s.oid, p.privilege_type)) AS effective_sequence_privileges
FROM checked_roles r
CROSS JOIN public_sequences s
CROSS JOIN sequence_privileges p
GROUP BY r.rolname
ORDER BY r.rolname;

WITH checked_roles AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('esdms_runtime', 'anon', 'authenticated')
),
public_sequences AS (
  SELECT c.oid
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'S'
),
sequence_privileges(privilege_type) AS (
  VALUES ('USAGE'), ('SELECT'), ('UPDATE')
)
SELECT NOT EXISTS (
  SELECT 1
  FROM checked_roles r
  CROSS JOIN public_sequences s
  CROSS JOIN sequence_privileges p
  WHERE has_sequence_privilege(r.rolname, s.oid, p.privilege_type)
) AS sequence_boundary_valid
\gset
\if :sequence_boundary_valid
\else
  \warn 'ERROR: runtime or browser roles retain public sequence privileges.'
  DO $abort$ BEGIN RAISE EXCEPTION 'sequence privilege verification failed'; END $abort$;
\endif

-- Only defaults owned by CURRENT_USER govern objects this migration owner
-- creates. Check both global defaults (namespace OID 0) and public-specific
-- defaults; unrelated supabase_admin defaults are owner-specific and do not
-- apply to ESDMS objects created by this role.
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  JOIN pg_roles grantee ON grantee.oid = a.grantee
  WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND (d.defaclnamespace = 0 OR n.nspname = 'public')
    AND d.defaclobjtype IN ('r', 'S')
    AND grantee.rolname IN ('esdms_runtime', 'anon', 'authenticated')
) AS default_privilege_boundary_valid
\gset
\if :default_privilege_boundary_valid
\else
  \warn 'ERROR: a default ACL still grants future public tables/sequences to runtime or browser roles.'
  DO $abort$ BEGIN RAISE EXCEPTION 'default privilege verification failed'; END $abort$;
\endif

-- Current public functions must not be callable through PUBLIC or either
-- browser role. Trigger execution does not require table callers to hold
-- direct EXECUTE on the trigger function.
WITH public_functions AS (
  SELECT p.oid, p.proacl, p.proowner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind <> 'p'
),
browser_roles AS (
  SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM public_functions f
    CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a
    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public_functions f
    CROSS JOIN browser_roles r
    WHERE has_function_privilege(r.rolname, f.oid, 'EXECUTE')
  ) AS function_execution_boundary_valid
\gset
\if :function_execution_boundary_valid
\else
  \warn 'ERROR: PUBLIC or a browser role can execute a current public function.'
  DO $abort$ BEGIN RAISE EXCEPTION 'function execution boundary verification failed'; END $abort$;
\endif

-- Runtime may call only the two narrow readiness functions. Trigger functions
-- remain executable through their table triggers without a direct grant.
WITH expected_functions(function_name, identity_arguments) AS (
  VALUES
    ('esdms_schema_migration_state', 'expected_name text'),
    ('esdms_runtime_provisioning_version', '')
),
public_functions AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind <> 'p'
)
SELECT
  NOT EXISTS (
    SELECT 1
    FROM expected_functions e
    WHERE NOT EXISTS (
      SELECT 1 FROM public_functions f
      WHERE f.proname = e.function_name
        AND f.identity_arguments = e.identity_arguments
        AND has_function_privilege('esdms_runtime', f.oid, 'EXECUTE')
    )
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public_functions f
    WHERE has_function_privilege('esdms_runtime', f.oid, 'EXECUTE')
      AND NOT EXISTS (
        SELECT 1 FROM expected_functions e
        WHERE e.function_name = f.proname AND e.identity_arguments = f.identity_arguments
      )
  ) AS runtime_function_boundary_valid
\gset
\if :runtime_function_boundary_valid
\else
  \warn 'ERROR: esdms_runtime has missing or unintended public function EXECUTE privileges.'
  DO $abort$ BEGIN RAISE EXCEPTION 'runtime function boundary verification failed'; END $abort$;
\endif

-- The stamp must name the migration level actually present right now. It was
-- derived from this same ledger moments ago, so a mismatch means the schema
-- moved underneath this run and the release must not be reported successful.
SELECT public.esdms_runtime_provisioning_version()
       = (SELECT (ARRAY_AGG(m.name ORDER BY m.id DESC))[1] FROM public.pgmigrations m)
       AS runtime_provisioning_version_valid
\gset
\if :runtime_provisioning_version_valid
\else
  \warn 'ERROR: runtime provisioning version marker is stale.'
  DO $abort$ BEGIN RAISE EXCEPTION 'runtime provisioning version verification failed'; END $abort$;
\endif

-- Future functions created by this migration owner must not inherit EXECUTE
-- for PUBLIC or browser roles. Defaults owned by other object creators are
-- deliberately outside this ESDMS owner boundary.
SELECT NOT EXISTS (
  SELECT 1
  FROM pg_default_acl d
  LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  CROSS JOIN LATERAL aclexplode(d.defaclacl) a
  LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee
  WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
    AND (d.defaclnamespace = 0 OR n.nspname = 'public')
    AND d.defaclobjtype = 'f'
    AND a.privilege_type = 'EXECUTE'
    AND (a.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated'))
) AS function_default_boundary_valid
\gset
\if :function_default_boundary_valid
\else
  \warn 'ERROR: migration-owner defaults grant future function EXECUTE to PUBLIC or browser roles.'
  DO $abort$ BEGIN RAISE EXCEPTION 'function default privilege verification failed'; END $abort$;
\endif

COMMIT;
\unset runtime_password

-- After this succeeds, configure the API's DATABASE_URL with esdms_runtime.
-- Keep MIGRATION_DATABASE_URL owner-only and use it solely for reviewed
-- migrations and this provisioning script.
