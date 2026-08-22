export const shorthands = undefined;

// The product is being demonstrated at one E-Set site today, but the
// platform is explicitly meant to expand to more. Introducing the site
// concept now — while there is one deterministic default site and little
// data — is far cheaper than retrofitting it after real multi-site data
// exists. Every existing row backfills to this one default site; nothing
// about current behavior changes until a second site is ever created.
const DEFAULT_SITE_CODE = "MAIN";
const DEFAULT_SITE_NAME = "E-Set — Main Site";

export async function up(pgm) {
  pgm.createTable("sites", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    code: {
      type: "varchar(50)",
      notNull: true,
      unique: true,
    },
    name: {
      type: "varchar(150)",
      notNull: true,
    },
    is_active: {
      type: "boolean",
      notNull: true,
      default: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.sql(
    `INSERT INTO sites (code, name) VALUES ('${DEFAULT_SITE_CODE}', '${DEFAULT_SITE_NAME}');`,
  );

  // users, departments, gate_passes each get a nullable site_id, backfilled
  // to the default site, then locked to NOT NULL — the standard safe
  // pattern for adding a required column to tables that already have rows.
  for (const table of ["users", "departments", "gate_passes"]) {
    pgm.addColumn(table, {
      site_id: {
        type: "uuid",
        references: "sites",
        onDelete: "RESTRICT",
      },
    });

    pgm.sql(`
      UPDATE ${table} SET site_id = (SELECT id FROM sites WHERE code = '${DEFAULT_SITE_CODE}')
      WHERE site_id IS NULL;
    `);

    pgm.alterColumn(table, "site_id", { notNull: true });
    pgm.createIndex(table, "site_id");
  }

  // Department names only need to be unique within one site now that more
  // than one site can exist — two sites plausibly both have a "Warehouse".
  pgm.dropConstraint("departments", "departments_name_key");
  pgm.addConstraint("departments", "departments_site_id_name_key", {
    unique: ["site_id", "name"],
  });
}

export async function down(pgm) {
  pgm.dropConstraint("departments", "departments_site_id_name_key");
  pgm.addConstraint("departments", "departments_name_key", { unique: ["name"] });

  for (const table of ["gate_passes", "departments", "users"]) {
    pgm.dropColumns(table, ["site_id"]);
  }

  pgm.dropTable("sites");
}
