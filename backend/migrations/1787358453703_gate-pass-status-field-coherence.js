export const shorthands = undefined;

// A row's status implies which "who/when/why" fields must already be
// filled in — enforced here, not just in the service layer, as defense in
// depth against any future write path (a bug, a script, a repair query)
// leaving a Gate Pass in a state its own audit fields don't support.
const CHECK = `
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
  pgm.addConstraint("gate_passes", "gate_passes_status_field_coherence_check", { check: CHECK });
}

export async function down(pgm) {
  pgm.dropConstraint("gate_passes", "gate_passes_status_field_coherence_check");
}
