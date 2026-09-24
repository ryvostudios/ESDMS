import { EXPECTED_MIGRATION } from "./schema-compatibility.js";

export const EXPECTED_RUNTIME_PROVISIONING = EXPECTED_MIGRATION;

const BOUNDARY_QUERY = `WITH
runtime_role AS (
  SELECT oid, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
  FROM pg_roles
  WHERE rolname = 'esdms_runtime'
),
standard_critical_tables(table_name) AS (
  VALUES
    ('users'), ('roles'), ('sites'), ('employees'), ('employment_assignments'),
    ('departments'), ('permissions'), ('role_permissions'),
    ('user_permission_overrides'), ('drivers'), ('vehicles')
),
dml_privileges(privilege_type) AS (
  VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')
),
expected_critical_privileges(table_name, privilege_type) AS (
  SELECT t.table_name, p.privilege_type
  FROM standard_critical_tables t CROSS JOIN dml_privileges p
  UNION ALL VALUES
    ('cms_settings', 'SELECT'),
    ('cms_settings', 'UPDATE'),
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
  SELECT c.oid, c.relname, c.relrowsecurity, c.relowner
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
),
runtime_accessible_tables AS (
  SELECT DISTINCT r.oid, r.relname, r.relrowsecurity
  FROM public_relations r
  CROSS JOIN runtime_role rr
  CROSS JOIN dml_privileges p
  WHERE r.relname <> 'pgmigrations'
    AND has_table_privilege(rr.oid, r.oid, p.privilege_type)
),
expected_functions(function_name, identity_arguments) AS (
  VALUES
    ('esdms_schema_migration_state', 'expected_name text'),
    ('esdms_runtime_provisioning_version', '')
),
public_functions AS (
  SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS identity_arguments, p.proowner
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind <> 'p'
)
SELECT
  current_user AS active_database_role,
  (SELECT count(*) = 1 FROM runtime_role) AS runtime_role_exists,
  COALESCE((
    SELECT rolcanlogin AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    FROM runtime_role
  ), false) AS runtime_role_attributes_safe,
  NOT EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN runtime_role rr ON rr.oid = m.member
  ) AS runtime_role_has_no_memberships,
  COALESCE((
    SELECT has_schema_privilege(rr.oid, 'public', 'USAGE')
       AND NOT has_schema_privilege(rr.oid, 'public', 'CREATE')
    FROM runtime_role rr
  ), false) AS runtime_schema_boundary_valid,
  (SELECT count(*) = 1 FROM runtime_role rr)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_critical_privileges e
      LEFT JOIN public_relations r ON r.relname = e.table_name
      CROSS JOIN runtime_role rr
      WHERE r.oid IS NULL OR NOT has_table_privilege(rr.oid, r.oid, e.privilege_type)
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public_relations r
      CROSS JOIN all_table_privileges p
      CROSS JOIN runtime_role rr
      WHERE r.relname IN (SELECT table_name FROM expected_critical_privileges)
        AND has_table_privilege(rr.oid, r.oid, p.privilege_type)
        AND NOT EXISTS (
          SELECT 1 FROM expected_critical_privileges e
          WHERE e.table_name = r.relname AND e.privilege_type = p.privilege_type
        )
    ) AS critical_table_privileges_valid,
  NOT EXISTS (
    SELECT 1
    FROM public_relations r
    CROSS JOIN all_table_privileges p
    CROSS JOIN runtime_role rr
    WHERE r.relname = 'pgmigrations'
      AND has_table_privilege(rr.oid, r.oid, p.privilege_type)
  ) AS pgmigrations_boundary_valid,
  NOT EXISTS (
    SELECT 1
    FROM runtime_accessible_tables t
    WHERE NOT t.relrowsecurity
       OR NOT EXISTS (
         SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND p.tablename = t.relname
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
  ) AS runtime_rls_boundary_valid,
  NOT EXISTS (
    SELECT 1
    FROM pg_class c CROSS JOIN runtime_role rr
    WHERE c.relowner = rr.oid
    UNION ALL
    SELECT 1
    FROM pg_proc p CROSS JOIN runtime_role rr
    WHERE p.proowner = rr.oid
    UNION ALL
    SELECT 1
    FROM pg_namespace n CROSS JOIN runtime_role rr
    WHERE n.nspowner = rr.oid
    UNION ALL
    SELECT 1
    FROM pg_database d CROSS JOIN runtime_role rr
    WHERE d.datdba = rr.oid
  ) AS runtime_owns_no_database_objects,
  NOT EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN runtime_role rr
    CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) p(privilege_type)
    WHERE n.nspname = 'public' AND c.relkind = 'S'
      AND has_sequence_privilege(rr.oid, c.oid, p.privilege_type)
  ) AS runtime_sequence_boundary_valid,
  (SELECT count(*) = 1 FROM runtime_role)
    AND NOT EXISTS (
      SELECT 1
      FROM expected_functions e
      WHERE NOT EXISTS (
        SELECT 1
        FROM public_functions f CROSS JOIN runtime_role rr
        WHERE f.proname = e.function_name
          AND f.identity_arguments = e.identity_arguments
          AND has_function_privilege(rr.oid, f.oid, 'EXECUTE')
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public_functions f CROSS JOIN runtime_role rr
      WHERE has_function_privilege(rr.oid, f.oid, 'EXECUTE')
        AND NOT EXISTS (
          SELECT 1 FROM expected_functions e
          WHERE e.function_name = f.proname AND e.identity_arguments = f.identity_arguments
        )
    ) AS runtime_function_boundary_valid,
  to_regprocedure('public.esdms_runtime_provisioning_version()') IS NOT NULL
    AS provisioning_marker_present`;

export async function inspectRuntimeCompatibility(executor, { requireRuntimeRole = false } = {}) {
  const result = await executor.query(BOUNDARY_QUERY);
  const state = result.rows[0];
  let actualRuntimeProvisioning = null;

  if (state.provisioning_marker_present) {
    try {
      const marker = await executor.query(
        "SELECT public.esdms_runtime_provisioning_version() AS provisioning_version",
      );
      actualRuntimeProvisioning = marker.rows[0]?.provisioning_version || null;
    } catch {
      // Missing EXECUTE is itself a failed serving contract. Keep the native
      // database error out of the readiness response and report incompatibility.
    }
  }

  const checks = {
    activeRuntimeRole: !requireRuntimeRole || state.active_database_role === "esdms_runtime",
    runtimeRoleExists: state.runtime_role_exists,
    runtimeRoleAttributesSafe: state.runtime_role_attributes_safe,
    runtimeRoleHasNoMemberships: state.runtime_role_has_no_memberships,
    runtimeSchemaBoundaryValid: state.runtime_schema_boundary_valid,
    criticalTablePrivilegesValid: state.critical_table_privileges_valid,
    pgmigrationsBoundaryValid: state.pgmigrations_boundary_valid,
    runtimeRlsBoundaryValid: state.runtime_rls_boundary_valid,
    runtimeOwnsNoDatabaseObjects: state.runtime_owns_no_database_objects,
    runtimeSequenceBoundaryValid: state.runtime_sequence_boundary_valid,
    runtimeFunctionBoundaryValid: state.runtime_function_boundary_valid,
    provisioningVersionCurrent: actualRuntimeProvisioning === EXPECTED_RUNTIME_PROVISIONING,
  };

  return {
    expectedRuntimeProvisioning: EXPECTED_RUNTIME_PROVISIONING,
    actualRuntimeProvisioning,
    runtimeProvisioningCompatible: Object.values(checks).every(Boolean),
    checks,
  };
}
