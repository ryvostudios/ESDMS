export const shorthands = undefined;

// One capability plus one audit action: an erroneous Demand List that is
// still an untouched DRAFT can be removed by an authorized actor.
//
// Hard deletion is deliberately confined to DRAFT. Everything past SUBMIT
// already has a review/rejection lifecycle, and `material_demand_pricing`
// and `ipos` reference `material_demands` with ON DELETE RESTRICT, so the
// database itself refuses to drop a Demand that ever reached procurement —
// the service-layer DRAFT check and this migration's FK backstop are
// independent defenses, exactly like the contract immutability trigger.
//
// `demand.delete_draft` is a capability of its own rather than an implied
// consequence of `demand.edit`: editing a draft and destroying it are
// different authorities, and bundling them would silently hand permanent
// delete power to every existing editor (including through any existing
// GRANT override). Role defaults mirror who can already create a Demand —
// deleting one's own untouched draft is the inverse of creating it — plus
// CEO, whose company-wide authority already covers every department.
// GATE_GUARD, HR and ordinary EMPLOYEE deliberately receive nothing.

const GOVERNANCE_AUDIT_ACTIONS = [
  "USER_CREATED",
  "USER_ROLE_CHANGED",
  "USER_ACTIVATED",
  "USER_DEACTIVATED",
  "PERMISSION_GRANTED",
  "PERMISSION_DENIED",
  "PERMISSION_OVERRIDE_REMOVED",
  "PRIVILEGE_ESCALATION_ATTEMPT",
  "EMPLOYEE_CREATED",
  "EMPLOYEE_TRANSFERRED",
  "COMPENSATION_RECORDED",
  "CONTRACT_FINALIZED",
  "CONTRACT_AMENDED",
  "CONTRACT_VIEWED",
  "CONTRACT_DOWNLOADED",
  "HISTORY_REMOVED",
  "WORKFORCE_EXPORT_GENERATED",
  "WORKFORCE_BULK_EXPORT_GENERATED",
  "WORKFORCE_BULK_IMPORT_COMPLETED",
  "EMPLOYEE_EXISTING_USER_LINKED",
  "USER_TEMP_PASSWORD_REGENERATED",
  "PROCUREMENT_EXPORT_GENERATED",
  // New: a deleted draft's own material_demand_audit_log rows cascade away
  // with it, so this append-only governance row is the only surviving
  // record that the Demand ever existed. It carries identity and size
  // (number, department, line count) — never the business payload.
  "DEMAND_DRAFT_DELETED",
];

const PERMISSIONS = [["demand.delete_draft", "Permanently delete a Demand List that is still an untouched DRAFT"]];

const ROLE_PERMISSIONS = {
  CEO: ["demand.delete_draft"],
  SITE_MANAGER: ["demand.delete_draft"],
  ADMIN: ["demand.delete_draft"],
  TEAM_LEAD: ["demand.delete_draft"],
};

export async function up(pgm) {
  // Persistent proof of delete eligibility, because current status alone is
  // not enough at the upgrade boundary. A Demand created under the OLD schema
  // could legitimately leave DRAFT, be forced back to DRAFT by direct SQL
  // (nothing forbade it then), and would afterwards be indistinguishable from
  // an untouched DRAFT — the rollback trigger below can only police
  // transitions that happen after it exists, never reconstruct ones that
  // already did.
  //
  // NOT NULL DEFAULT false backfills every pre-existing row as ineligible.
  // That is deliberately conservative: some genuinely untouched legacy DRAFTs
  // become permanently undeletable, which is the correct trade — old data
  // predates the invariant and cannot be proven safe. No legacy row is
  // deleted or rewritten to "clean this up".
  pgm.addColumn("material_demands", {
    draft_delete_eligible: { type: "boolean", notNull: true, default: false },
  });

  // Set by the database, never by the caller: the API layer does not accept
  // this field at all, and this trigger means even a direct INSERT cannot
  // hand itself eligibility while starting outside DRAFT.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION material_demands_set_draft_delete_eligible()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      NEW.draft_delete_eligible := (NEW.status = 'DRAFT');
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql("DROP TRIGGER IF EXISTS material_demands_set_draft_delete_eligible ON material_demands;");
  pgm.sql(`
    CREATE TRIGGER material_demands_set_draft_delete_eligible
    BEFORE INSERT ON material_demands
    FOR EACH ROW
    EXECUTE FUNCTION material_demands_set_draft_delete_eligible();
  `);

  // Deleting a Demand is confined to one that has NEVER left DRAFT. Status
  // alone would be a weak proxy for that, so this trigger is what makes the
  // two equivalent: leaving DRAFT is one-way, therefore a row that is DRAFT
  // now provably never held any other status. Without it a direct
  // `UPDATE material_demands SET status = 'DRAFT'` on a submitted Demand
  // re-opens the delete path and the FK cascade then destroys its audit
  // history.
  //
  // Only the non-DRAFT -> DRAFT edge is refused. Every other transition,
  // including the legitimate backward ones the workflow already performs
  // (PENDING_FINAL_APPROVAL -> READY_FOR_PRICING, and the
  // PRICING_REVISION_REQUIRED return), is untouched, as are DRAFT edits that
  // do not move status at all.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION material_demands_forbid_draft_rollback()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.status <> 'DRAFT' AND NEW.status = 'DRAFT' THEN
        RAISE EXCEPTION 'A Demand that has left DRAFT can never return to DRAFT.';
      END IF;

      -- Eligibility is strictly one-way. Nothing may hand it back, so a
      -- direct UPDATE ... SET draft_delete_eligible = true cannot resurrect
      -- a legacy or already-submitted Demand into a deletable one.
      IF NEW.draft_delete_eligible AND NOT OLD.draft_delete_eligible THEN
        RAISE EXCEPTION 'draft_delete_eligible can never be restored once cleared.';
      END IF;

      -- Leaving DRAFT clears it permanently, regardless of what the caller
      -- supplied for the column in the same statement.
      IF OLD.status = 'DRAFT' AND NEW.status <> 'DRAFT' THEN
        NEW.draft_delete_eligible := false;
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql("DROP TRIGGER IF EXISTS material_demands_forbid_draft_rollback ON material_demands;");
  // Named to sort before material_demands_set_updated_at so the lifecycle
  // check runs first; it returns NEW untouched, so the timestamp trigger
  // behaves exactly as before.
  pgm.sql(`
    CREATE TRIGGER material_demands_forbid_draft_rollback
    BEFORE UPDATE ON material_demands
    FOR EACH ROW
    EXECUTE FUNCTION material_demands_forbid_draft_rollback();
  `);

  // material_demand_audit_log stays append-only against every caller: UPDATE
  // is always refused, and a DELETE issued against this table directly is
  // refused too — including while the owning Demand is still a DRAFT, which
  // the first version of this migration wrongly allowed.
  //
  // The single permitted deletion is the ON DELETE CASCADE of a parent that
  // was itself legitimately deletable, and that context is identified by two
  // independently sufficient facts, both required:
  //
  //   pg_trigger_depth() > 1  — this trigger is running nested inside the
  //     parent's cascade rather than as a caller's own statement; and
  //   the parent row is already gone — the FK cascade removes the parent
  //     before its children, so a direct DELETE still sees it.
  //
  // Measured on this schema: a direct child DELETE reports depth = 1 with the
  // parent present, a cascade reports depth = 2 with the parent absent. The
  // conditions are not merely heuristic here, because reaching the cascade at
  // all requires deleting the parent, which the DRAFT-only delete guard plus
  // the rollback guard above already restrict to a Demand that never left
  // DRAFT. No session flag, GUC or application state is consulted.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION material_demand_audit_log_guard()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'material_demand_audit_log rows are append-only.';
      END IF;

      IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'material_demand_audit_log rows are append-only: they cannot be deleted directly.';
      END IF;

      IF EXISTS (SELECT 1 FROM material_demands WHERE id = OLD.demand_id) THEN
        RAISE EXCEPTION 'material_demand_audit_log rows are append-only: the owning Demand still exists.';
      END IF;

      RETURN OLD;
    END;
    $$;
  `);

  // material_demands itself carries a blanket forbid_delete() trigger. Same
  // treatment: refuse every delete except a Demand still in DRAFT, so the
  // database — not just the service layer — is what makes a submitted Demand
  // undeletable, exactly as before this migration.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION material_demands_forbid_delete_unless_draft()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'Deletion of material_demands rows is not permitted once the Demand has been submitted.';
      END IF;

      -- Being a DRAFT right now is not sufficient; the row must also carry
      -- the persistent proof that it has only ever been a DRAFT.
      IF NOT OLD.draft_delete_eligible THEN
        RAISE EXCEPTION 'Deletion of material_demands rows is not permitted: this Demand is not eligible for draft deletion.';
      END IF;

      RETURN OLD;
    END;
    $$;
  `);
  pgm.sql("DROP TRIGGER IF EXISTS material_demands_forbid_delete ON material_demands;");
  pgm.sql(`
    CREATE TRIGGER material_demands_forbid_delete
    BEFORE DELETE ON material_demands
    FOR EACH ROW
    EXECUTE FUNCTION material_demands_forbid_delete_unless_draft();
  `);

  pgm.sql("DROP TRIGGER IF EXISTS material_demand_audit_log_append_only ON material_demand_audit_log;");
  pgm.sql(`
    CREATE TRIGGER material_demand_audit_log_append_only
    BEFORE UPDATE OR DELETE ON material_demand_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION material_demand_audit_log_guard();
  `);

  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${GOVERNANCE_AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });

  for (const [code, description] of PERMISSIONS) {
    pgm.sql(`INSERT INTO permissions (code, description) VALUES ('${code}', '${description.replace(/'/g, "''")}');`);
  }
  for (const [role, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      pgm.sql(`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r, permissions p
        WHERE r.name = '${role}' AND p.code = '${code}'
        ON CONFLICT DO NOTHING;
      `);
    }
  }
}

export async function down(pgm) {
  pgm.sql("DROP TRIGGER IF EXISTS material_demand_audit_log_append_only ON material_demand_audit_log;");
  pgm.sql(`
    CREATE TRIGGER material_demand_audit_log_append_only
    BEFORE UPDATE OR DELETE ON material_demand_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);
  pgm.sql("DROP FUNCTION IF EXISTS material_demand_audit_log_guard();");

  pgm.sql("DROP TRIGGER IF EXISTS material_demands_forbid_delete ON material_demands;");
  pgm.sql(`
    CREATE TRIGGER material_demands_forbid_delete
    BEFORE DELETE ON material_demands
    FOR EACH ROW
    EXECUTE FUNCTION forbid_delete();
  `);
  pgm.sql("DROP FUNCTION IF EXISTS material_demands_forbid_delete_unless_draft();");

  // Pre-hotfix there was no lifecycle rollback guard, because a blanket
  // forbid_delete() made the DRAFT loophole unreachable anyway.
  pgm.sql("DROP TRIGGER IF EXISTS material_demands_forbid_draft_rollback ON material_demands;");
  pgm.sql("DROP FUNCTION IF EXISTS material_demands_forbid_draft_rollback();");

  pgm.sql("DROP TRIGGER IF EXISTS material_demands_set_draft_delete_eligible ON material_demands;");
  pgm.sql("DROP FUNCTION IF EXISTS material_demands_set_draft_delete_eligible();");
  // Dropping the column loses only the eligibility bookkeeping this migration
  // introduced; no business or audit data lives here. Re-applying UP backfills
  // every surviving row as ineligible again, which is the conservative side.
  pgm.dropColumn("material_demands", "draft_delete_eligible");

  // governance_audit_log is append-only at the database level, so the rows
  // this feature produced cannot be deleted to make room for the narrower
  // CHECK constraint — the original down() tried exactly that and failed
  // with 'governance_audit_log rows are append-only' the moment a single
  // draft had ever been deleted, leaving the migration un-rollbackable.
  // Refuse loudly and early instead: destroying governance history to enable
  // a rollback would be a far worse outcome than an irreversible migration,
  // and this mirrors the deliberate irreversibility of
  // database-runtime-security-boundary. With no such rows (the feature was
  // never exercised) the rollback proceeds and fully restores pre-hotfix state.
  pgm.sql(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM governance_audit_log WHERE action = 'DEMAND_DRAFT_DELETED') THEN
        RAISE EXCEPTION 'Cannot roll back demand-draft-delete: DEMAND_DRAFT_DELETED governance rows exist and governance_audit_log is append-only. Retire the capability with a new forward migration instead.';
      END IF;
    END;
    $$;
  `);
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${GOVERNANCE_AUDIT_ACTIONS.slice(0, -1)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });

  pgm.sql(`
    DELETE FROM user_permission_overrides
    WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'demand.delete_draft');
    DELETE FROM role_permissions
    WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'demand.delete_draft');
    DELETE FROM permissions WHERE code = 'demand.delete_draft';
  `);
}
