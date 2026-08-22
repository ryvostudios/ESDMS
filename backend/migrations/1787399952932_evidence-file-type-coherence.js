/**
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

// The existing composite FK (gate_passes_departure_photo_ownership_fkey /
// ..._return_photo_ownership_fkey, see 1787391715256_db-relational-coherence)
// only guarantees the referenced file belongs to the SAME Gate Pass — not
// that it's the RIGHT KIND of file. departure_photo_file_id could still
// point at an APPROVED_PDF or the return photo. A composite FK can't
// express "must equal this literal file_type" (both sides of a FK must be
// real columns), so this uses a narrow, single-purpose trigger instead —
// scoped only to these two columns, not a general-purpose/magic trigger.

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  // Fail the migration loudly if any existing row already violates the
  // invariant, rather than silently start enforcing only from this point
  // forward while a bad row lurks underneath it.
  pgm.sql(`
    DO $$
    DECLARE
      bad_count integer;
    BEGIN
      SELECT count(*) INTO bad_count
      FROM gate_passes gp
      WHERE (
        gp.departure_photo_file_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM gate_pass_files f
          WHERE f.id = gp.departure_photo_file_id AND f.file_type = 'DEPARTURE_PHOTO'
        )
      ) OR (
        gp.return_photo_file_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM gate_pass_files f
          WHERE f.id = gp.return_photo_file_id AND f.file_type = 'RETURN_PHOTO'
        )
      );

      IF bad_count > 0 THEN
        RAISE EXCEPTION 'evidence-file-type-coherence: % existing gate_passes row(s) reference a departure/return photo file with the wrong file_type — fix the data before applying this migration.', bad_count;
      END IF;
    END $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION check_gate_pass_photo_file_type()
    RETURNS TRIGGER AS $$
    BEGIN
      IF NEW.departure_photo_file_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM gate_pass_files
        WHERE id = NEW.departure_photo_file_id AND file_type = 'DEPARTURE_PHOTO'
      ) THEN
        RAISE EXCEPTION 'departure_photo_file_id must reference a gate_pass_files row with file_type = DEPARTURE_PHOTO';
      END IF;

      IF NEW.return_photo_file_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM gate_pass_files
        WHERE id = NEW.return_photo_file_id AND file_type = 'RETURN_PHOTO'
      ) THEN
        RAISE EXCEPTION 'return_photo_file_id must reference a gate_pass_files row with file_type = RETURN_PHOTO';
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  // UPDATE OF ... scopes this to fire only when these two columns are
  // actually part of the UPDATE statement (markExited/markReturned are the
  // only writers) — not on every unrelated gate_passes update (approve,
  // reject, cancel, etc.).
  pgm.sql(`
    CREATE TRIGGER gate_passes_photo_file_type_check
    BEFORE INSERT OR UPDATE OF departure_photo_file_id, return_photo_file_id ON gate_passes
    FOR EACH ROW
    EXECUTE FUNCTION check_gate_pass_photo_file_type();
  `);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.sql(`DROP TRIGGER IF EXISTS gate_passes_photo_file_type_check ON gate_passes;`);
  pgm.sql(`DROP FUNCTION IF EXISTS check_gate_pass_photo_file_type();`);
};
