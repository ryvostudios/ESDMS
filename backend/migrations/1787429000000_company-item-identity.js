export const shorthands = undefined;

// Company Item is documented as the GLOBAL physical identity
// (docs/INVERSE_ACTION_AUDIT.md), and previous-purchase price comparison
// keys on the exact company_item_id. Nothing enforced that identity:
// `company_items.name` carried only a plain btree index, and the create-time
// duplicate warning filtered exact-name matches OUT of its own result
// (material-catalog.service.js), so typing the same item name twice silently
// produced two global identities with no warning at all. Procurement's
// previous_purchase_unit_price — a core control for detecting overpricing —
// then reports "no previous purchase" for the twin.
//
// The normalization is deliberately narrow: trim, collapse internal
// whitespace, lowercase. That is "exact normalized identity" and nothing
// more. Two genuinely different materials may legitimately share similar
// names ("Cement" vs "Cement Grade A"), and the create-time similarity
// WARNING continues to handle that case without blocking it — see
// docs/INVERSE_ACTION_AUDIT.md, which records that automated merge is
// deliberately out of scope because equivalence is a business decision.
//
// The index deliberately covers archived rows too. If it did not, archiving
// an item would let the same name be created as a second identity, which is
// exactly the fragmentation this prevents; the correct inverse of an
// archived item is to restore it, which the catalog already supports.

export const NORMALIZED_NAME_EXPRESSION = "lower(regexp_replace(btrim(name), '\\s+', ' ', 'g'))";

export async function up(pgm) {
  // Pre-existing duplicates are a real data defect that only a human can
  // resolve: merging two Company Items reassigns purchase history and is a
  // business judgement about whether they are the same physical thing. This
  // migration therefore refuses to run rather than merging, renaming or
  // silently skipping the invariant — and names the exact conflicts so the
  // operator can resolve them in the application first.
  //
  // `npm run report:duplicate-company-items` lists the same set read-only,
  // so this can be checked before a release rather than discovered during one.
  pgm.sql(`
    DO $duplicates$
    DECLARE
      conflicts text;
    BEGIN
      SELECT string_agg(format('%s (x%s)', normalized, occurrences), ', ' ORDER BY normalized)
        INTO conflicts
      FROM (
        SELECT ${NORMALIZED_NAME_EXPRESSION} AS normalized, count(*) AS occurrences
        FROM company_items
        GROUP BY 1
        HAVING count(*) > 1
      ) duplicated;

      IF conflicts IS NOT NULL THEN
        RAISE EXCEPTION
          'Company Items already share a normalized name and must be resolved before this migration can enforce global identity: %. Archive or rename the duplicates in the application first; they are not merged automatically because deciding two records are the same physical item is a business decision that reassigns purchase history.',
          conflicts;
      END IF;
    END
    $duplicates$;
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX company_items_normalized_name_key
    ON company_items (${NORMALIZED_NAME_EXPRESSION});
  `);
}

export async function down(pgm) {
  pgm.sql("DROP INDEX IF EXISTS company_items_normalized_name_key;");
}
