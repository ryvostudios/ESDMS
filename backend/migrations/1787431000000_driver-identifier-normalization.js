export const shorthands = undefined;

// Driver CNIC and licence uniqueness was case- and whitespace-sensitive while
// vehicle registration was not, so the same real identifier could be entered
// twice for one site:
//
//   POST /vehicles {"registrationNumber":" aud-123 "}  -> 409 (blocked)
//   POST /drivers  {"licenceNumber":"lic-001"}         -> 201 (LIC-001 exists)
//
// That produces two Driver records for one licence, each accumulating its own
// Gate Pass history — the same identity fragmentation the vehicle index
// already prevents. docs/INVERSE_ACTION_AUDIT.md documents registration as
// "unique per site, case-insensitively" and makes no equivalent claim for
// Driver, so the inconsistency was an oversight rather than a decision.
//
// Normalization matches vehicles_site_registration_key's intent — compare the
// identifier, not its typing — and additionally collapses whitespace, since a
// CNIC or licence is routinely typed with stray spaces. Both indexes stay
// PARTIAL (the columns are nullable and a driver may legitimately have
// neither) and stay scoped per site, so two sites may still deal with the same
// contractor driver and neither can probe the other's master data by watching
// for a conflict.

const NORMALIZED = (column) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;

export async function up(pgm) {
  // Pre-existing rows that differ only by case or spacing are a real data
  // defect, and merging two Driver records reassigns Gate Pass history — a
  // business decision, not something a migration may take. Refuse and name
  // the conflicts instead of merging, renaming or skipping the invariant.
  for (const [column, label] of [["cnic", "CNIC"], ["licence_number", "licence number"]]) {
    pgm.sql(`
      DO $duplicates$
      DECLARE
        conflicts text;
      BEGIN
        SELECT string_agg(format('%s (site %s, x%s)', normalized, site_id, occurrences), ', ')
          INTO conflicts
        FROM (
          SELECT site_id, ${NORMALIZED(column)} AS normalized, count(*) AS occurrences
          FROM drivers
          WHERE ${column} IS NOT NULL
          GROUP BY site_id, 2
          HAVING count(*) > 1
        ) duplicated;

        IF conflicts IS NOT NULL THEN
          RAISE EXCEPTION
            'Drivers at the same site already share a normalized ${label} and must be resolved first: %. Deactivate or correct the duplicate in the application; they are not merged automatically because that reassigns Gate Pass history.',
            conflicts;
        END IF;
      END
      $duplicates$;
    `);
  }

  pgm.sql(`
    DROP INDEX IF EXISTS drivers_site_cnic_key;
    DROP INDEX IF EXISTS drivers_site_licence_key;

    CREATE UNIQUE INDEX drivers_site_cnic_key
      ON drivers (site_id, ${NORMALIZED("cnic")}) WHERE cnic IS NOT NULL;
    CREATE UNIQUE INDEX drivers_site_licence_key
      ON drivers (site_id, ${NORMALIZED("licence_number")}) WHERE licence_number IS NOT NULL;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DROP INDEX IF EXISTS drivers_site_cnic_key;
    DROP INDEX IF EXISTS drivers_site_licence_key;

    CREATE UNIQUE INDEX drivers_site_cnic_key
      ON drivers (site_id, cnic) WHERE cnic IS NOT NULL;
    CREATE UNIQUE INDEX drivers_site_licence_key
      ON drivers (site_id, licence_number) WHERE licence_number IS NOT NULL;
  `);
}
