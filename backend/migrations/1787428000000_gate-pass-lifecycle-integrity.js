export const shorthands = undefined;

// Gate Pass lifecycle, enforced by the database rather than only by
// application code.
//
// Until now `gate_passes` had `gate_passes_forbid_delete` and
// `gate_passes_status_field_coherence_check`, but no transition guard — and
// the coherence CHECK is deliberately one-directional. It asserts that a
// terminal state HAS its fields; it never asserts that an earlier state
// LACKS them. A DRAFT row still carrying departure and return evidence
// therefore satisfies every existing constraint, and
//
//   UPDATE gate_passes SET status = 'DRAFT' WHERE status = 'COMPLETED';
//
// succeeded. Gate Pass is the physical-custody record for material leaving a
// site, so its status and evidence are the audit artefact; the layer that
// protects it from a future code defect, a mis-scoped repository method or a
// manual production "fix" simply did not exist, while Material Demand has had
// exactly this protection since 1787424000000_demand-draft-delete.js.
//
// The matrix below is reconstructed from the current authoritative source —
// gate-pass.constants.js TRANSITIONS plus the two Guard transitions in
// gate-pass.service.js (recordExit, recordReturn) — and invents nothing:
//
//   DRAFT             -> PENDING_APPROVAL   submit
//   DRAFT             -> APPROVED           approve (direct approval is allowed)
//   DRAFT             -> REJECTED           reject
//   DRAFT             -> CANCELLED          cancel
//   PENDING_APPROVAL  -> APPROVED           approve
//   PENDING_APPROVAL  -> REJECTED           reject
//   PENDING_APPROVAL  -> CANCELLED          cancel
//   APPROVED          -> VEHICLE_OUTSIDE    exit   (Guard)
//   APPROVED          -> CANCELLED          cancel
//   VEHICLE_OUTSIDE   -> COMPLETED          return (Guard)
//
// COMPLETED, REJECTED and CANCELLED are terminal: nothing leaves them.
//
// A status-preserving UPDATE stays fully allowed at every state. That is not
// a loophole, it is required: draft field edits, the departure/return column
// writes that accompany their own transition, and the updated_at trigger all
// write the row without changing status, and late-arriving inbound evidence
// is deliberately still accepted against a COMPLETED pass.

const ALLOWED_TRANSITIONS = [
  ["DRAFT", "PENDING_APPROVAL"],
  ["DRAFT", "APPROVED"],
  ["DRAFT", "REJECTED"],
  ["DRAFT", "CANCELLED"],
  ["PENDING_APPROVAL", "APPROVED"],
  ["PENDING_APPROVAL", "REJECTED"],
  ["PENDING_APPROVAL", "CANCELLED"],
  ["APPROVED", "VEHICLE_OUTSIDE"],
  ["APPROVED", "CANCELLED"],
  ["VEHICLE_OUTSIDE", "COMPLETED"],
];

export async function up(pgm) {
  const pairs = ALLOWED_TRANSITIONS.map(([from, to]) => `('${from}', '${to}')`).join(", ");

  pgm.sql(`
    CREATE OR REPLACE FUNCTION gate_passes_enforce_lifecycle()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      -- Status-preserving writes are ordinary field updates.
      IF NEW.status = OLD.status THEN
        RETURN NEW;
      END IF;

      IF NOT EXISTS (
        SELECT 1
        FROM (VALUES ${pairs}) AS allowed(from_status, to_status)
        WHERE allowed.from_status = OLD.status
          AND allowed.to_status = NEW.status
      ) THEN
        RAISE EXCEPTION
          'A Gate Pass cannot move from % to %.', OLD.status, NEW.status
          USING ERRCODE = 'check_violation';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);

  pgm.sql("DROP TRIGGER IF EXISTS gate_passes_enforce_lifecycle ON gate_passes;");
  // Named to sort before gate_passes_set_updated_at, so the lifecycle check
  // runs first. It returns NEW untouched, so the timestamp trigger and the
  // photo-file-type trigger behave exactly as before.
  pgm.sql(`
    CREATE TRIGGER gate_passes_enforce_lifecycle
    BEFORE UPDATE ON gate_passes
    FOR EACH ROW
    EXECUTE FUNCTION gate_passes_enforce_lifecycle();
  `);
}

export async function down(pgm) {
  pgm.sql("DROP TRIGGER IF EXISTS gate_passes_enforce_lifecycle ON gate_passes;");
  pgm.sql("DROP FUNCTION IF EXISTS gate_passes_enforce_lifecycle();");
}
