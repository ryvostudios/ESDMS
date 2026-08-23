export const shorthands = undefined;

// Forward hardening for installations that already ran the Workforce
// foundation while it was under review. Fresh installations receive the
// corrected contract trigger from 1787405000000 and safely replace it here.
export async function up(pgm) {
  pgm.sql(`
    INSERT INTO permissions (code, description)
    VALUES ('employees.bulk_import', 'Preview and transactionally import Employees from the approved XLSX template')
    ON CONFLICT (code) DO NOTHING;

    INSERT INTO role_permissions (role_id, permission_id)
    SELECT r.id, p.id FROM roles r, permissions p
    WHERE r.name IN ('CEO', 'HR') AND p.code IN ('employees.bulk_import', 'employee_documents.bulk_export')
    ON CONFLICT DO NOTHING;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION employee_contracts_enforce_immutability()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.status = 'DRAFT' THEN
        RETURN NEW;
      END IF;

      IF NOT (
        NEW.status = OLD.status
        OR (OLD.status = 'CURRENT' AND NEW.status IN ('SUPERSEDED', 'EXPIRED', 'TERMINATED'))
      ) THEN
        RAISE EXCEPTION 'employee_contracts: % -> % is not a permitted status transition on a finalized contract', OLD.status, NEW.status;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
         OR NEW.contract_number IS DISTINCT FROM OLD.contract_number
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.amends_contract_id IS DISTINCT FROM OLD.amends_contract_id
         OR NEW.effective_start_date IS DISTINCT FROM OLD.effective_start_date
         OR NEW.effective_end_date IS DISTINCT FROM OLD.effective_end_date
         OR NEW.terms_summary IS DISTINCT FROM OLD.terms_summary
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
         OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
         OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
         OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
         OR NEW.finalized_by_user_id IS DISTINCT FROM OLD.finalized_by_user_id
         OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'employee_contracts: a finalized contract is immutable except for its lifecycle status';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql(`
    CREATE TRIGGER employee_compensation_records_immutable
    BEFORE UPDATE OR DELETE ON employee_compensation_records
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();

    CREATE TRIGGER employee_profile_photos_forbid_update
    BEFORE UPDATE ON employee_profile_photos
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION employee_documents_guard_update()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
         OR NEW.document_type_id IS DISTINCT FROM OLD.document_type_id
         OR NEW.version IS DISTINCT FROM OLD.version
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
         OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
         OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
         OR NEW.original_filename IS DISTINCT FROM OLD.original_filename
         OR NEW.uploaded_by_user_id IS DISTINCT FROM OLD.uploaded_by_user_id
         OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
         OR NEW.expiry_date IS DISTINCT FROM OLD.expiry_date THEN
        RAISE EXCEPTION 'employee_documents: stored file versions are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER employee_documents_guard_update
    BEFORE UPDATE ON employee_documents
    FOR EACH ROW EXECUTE FUNCTION employee_documents_guard_update();

    REVOKE EXECUTE ON FUNCTION employee_documents_guard_update() FROM PUBLIC;
  `);

  // Import completion belongs in the same append-only governance trail as
  // the other Workforce exports and sensitive mutations.
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED', 'USER_DEACTIVATED',
      'PERMISSION_GRANTED', 'PERMISSION_DENIED', 'PERMISSION_OVERRIDE_REMOVED',
      'PRIVILEGE_ESCALATION_ATTEMPT', 'EMPLOYEE_CREATED', 'EMPLOYEE_TRANSFERRED',
      'COMPENSATION_RECORDED', 'CONTRACT_FINALIZED', 'CONTRACT_AMENDED',
      'CONTRACT_VIEWED', 'CONTRACT_DOWNLOADED', 'HISTORY_REMOVED',
      'WORKFORCE_EXPORT_GENERATED', 'WORKFORCE_BULK_EXPORT_GENERATED',
      'WORKFORCE_BULK_IMPORT_COMPLETED'
    )`,
  });
}

export async function down(pgm) {
  // Retain the import action in the historical allowlist. Completed audit
  // rows are append-only evidence and must not be deleted merely to make a
  // code rollback possible.
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED', 'USER_DEACTIVATED',
      'PERMISSION_GRANTED', 'PERMISSION_DENIED', 'PERMISSION_OVERRIDE_REMOVED',
      'PRIVILEGE_ESCALATION_ATTEMPT', 'EMPLOYEE_CREATED', 'EMPLOYEE_TRANSFERRED',
      'COMPENSATION_RECORDED', 'CONTRACT_FINALIZED', 'CONTRACT_AMENDED',
      'CONTRACT_VIEWED', 'CONTRACT_DOWNLOADED', 'HISTORY_REMOVED',
      'WORKFORCE_EXPORT_GENERATED', 'WORKFORCE_BULK_EXPORT_GENERATED',
      'WORKFORCE_BULK_IMPORT_COMPLETED'
    )`,
  });
  pgm.sql(`DROP TRIGGER IF EXISTS employee_documents_guard_update ON employee_documents;`);
  pgm.sql(`DROP FUNCTION IF EXISTS employee_documents_guard_update();`);
  pgm.sql(`DROP TRIGGER IF EXISTS employee_profile_photos_forbid_update ON employee_profile_photos;`);
  pgm.sql(`DROP TRIGGER IF EXISTS employee_compensation_records_immutable ON employee_compensation_records;`);
  pgm.sql(`DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = 'employees.bulk_import');`);
  pgm.sql(`DELETE FROM permissions WHERE code = 'employees.bulk_import';`);
}
