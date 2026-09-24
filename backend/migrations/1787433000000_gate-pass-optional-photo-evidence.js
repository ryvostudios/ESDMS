export const shorthands = undefined;

// Departure and return photos become optional gate evidence.
//
// gate_passes_status_field_coherence_check (1787358453703) required
// departure_photo_file_id for VEHICLE_OUTSIDE/COMPLETED and
// return_photo_file_id for COMPLETED. This reproduces that CHECK exactly with
// ONLY those two conjuncts removed. Every other requirement stays:
// approval fields, rejection/cancellation fields, and the departure/return
// odometer, time and recorded-by actor.
//
// A NULL photo reference means "no photographic evidence was captured" — no
// placeholder file is ever written. When a reference IS set,
// gate_passes_photo_file_type_check (1787399952932) still requires it to be
// a DEPARTURE_PHOTO / RETURN_PHOTO file; that trigger already skips NULLs and
// is deliberately untouched here.
//
// Strictly a relaxation: every existing row satisfies the new CHECK, so no
// data is rewritten.

const RELAXED = `
  (status NOT IN ('APPROVED', 'VEHICLE_OUTSIDE', 'COMPLETED')
    OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND verification_token_hash IS NOT NULL))
  AND (status != 'REJECTED'
    OR (rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL))
  AND (status != 'CANCELLED'
    OR (cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL))
  AND (status NOT IN ('VEHICLE_OUTSIDE', 'COMPLETED')
    OR (departure_odometer IS NOT NULL AND departure_at IS NOT NULL
        AND departure_by_user_id IS NOT NULL))
  AND (status != 'COMPLETED'
    OR (return_odometer IS NOT NULL AND return_at IS NOT NULL
        AND return_by_user_id IS NOT NULL))
`;

const STRICT = `
  (status NOT IN ('APPROVED', 'VEHICLE_OUTSIDE', 'COMPLETED')
    OR (approved_by_user_id IS NOT NULL AND approved_at IS NOT NULL AND verification_token_hash IS NOT NULL))
  AND (status != 'REJECTED'
    OR (rejected_by_user_id IS NOT NULL AND rejected_at IS NOT NULL AND rejection_reason IS NOT NULL))
  AND (status != 'CANCELLED'
    OR (cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL AND cancellation_reason IS NOT NULL))
  AND (status NOT IN ('VEHICLE_OUTSIDE', 'COMPLETED')
    OR (departure_odometer IS NOT NULL AND departure_at IS NOT NULL
        AND departure_by_user_id IS NOT NULL AND departure_photo_file_id IS NOT NULL))
  AND (status != 'COMPLETED'
    OR (return_odometer IS NOT NULL AND return_at IS NOT NULL
        AND return_by_user_id IS NOT NULL AND return_photo_file_id IS NOT NULL))
`;

export async function up(pgm) {
  pgm.dropConstraint("gate_passes", "gate_passes_status_field_coherence_check");
  pgm.addConstraint("gate_passes", "gate_passes_status_field_coherence_check", { check: RELAXED });
}

// Restoring the strict CHECK is refused, not forced, once a movement has been
// recorded without a photo: evidence that was never captured cannot be
// invented to satisfy it.
export async function down(pgm) {
  pgm.sql(`
    DO $$
    DECLARE missing_count integer;
    BEGIN
      SELECT count(*) INTO missing_count FROM gate_passes
      WHERE (status IN ('VEHICLE_OUTSIDE', 'COMPLETED') AND departure_photo_file_id IS NULL)
         OR (status = 'COMPLETED' AND return_photo_file_id IS NULL);
      IF missing_count > 0 THEN
        RAISE EXCEPTION 'gate-pass-optional-photo-evidence: % gate_passes row(s) recorded a movement without a photo; the strict photo requirement cannot be restored.', missing_count;
      END IF;
    END $$;
  `);
  pgm.dropConstraint("gate_passes", "gate_passes_status_field_coherence_check");
  pgm.addConstraint("gate_passes", "gate_passes_status_field_coherence_check", { check: STRICT });
}
