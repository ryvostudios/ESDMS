import "dotenv/config";
import pool from "../src/config/database.js";
import { listDuplicateCompanyItemIdentities } from "../src/modules/material-catalog/material-catalog.repository.js";

// Read-only. Lists Company Items that share one normalized identity — the
// collisions company_items_normalized_name_key forbids going forward.
//
// It deliberately does NOT merge anything. Deciding that two Company Items
// are the same physical thing reassigns purchase history and is a business
// decision, which docs/INVERSE_ACTION_AUDIT.md already records as out of
// scope for automation. Resolve them in the application (archive or rename
// the redundant one), then re-run.
//
//   npm run report:duplicate-company-items

async function main() {
  const duplicates = await listDuplicateCompanyItemIdentities();

  if (duplicates.length === 0) {
    process.stdout.write("No Company Items share a normalized identity.\n");
    return;
  }

  process.stdout.write(
    `${duplicates.length} normalized identity/identities are held by more than one Company Item:\n\n`,
  );

  for (const row of duplicates) {
    process.stdout.write(`  "${row.normalized_name}" — ${row.occurrences} records\n`);
    row.company_item_ids.forEach((id, index) => {
      process.stdout.write(`      ${id}  ${row.names[index]}\n`);
    });
    process.stdout.write("\n");
  }

  process.stdout.write(
    "Resolve each set in the application before the identity migration can run:\n" +
      "archive or rename the redundant record. They are not merged automatically,\n" +
      "because that reassigns purchase history and is a business decision.\n",
  );
  process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
