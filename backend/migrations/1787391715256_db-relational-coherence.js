export const shorthands = undefined;

// Service-layer authorization already prevents these combinations from
// ever being written — this migration makes that guarantee a DB-level
// invariant too, as defense in depth against a future bug or a raw SQL
// script bypassing the service layer. Composite FKs, not triggers: each
// one directly expresses "these two columns on the child row must match
// the referenced row's own columns," which is clearer and cheaper than a
// hand-written trigger doing the same join.
export async function up(pgm) {
  // A department's site is its own natural key extension — every FK below
  // pins a department reference to a specific site via this.
  pgm.addConstraint("departments", "departments_id_site_id_key", {
    unique: ["id", "site_id"],
  });

  // A user's department (when set — department_id is nullable for
  // roles like ADMIN/SITE_MANAGER/GATE_GUARD) must belong to the user's
  // own site. NULL department_id trivially satisfies a composite FK.
  pgm.addConstraint("users", "users_department_site_fkey", {
    foreignKeys: {
      columns: ["department_id", "site_id"],
      references: "departments(id, site_id)",
    },
  });

  // A Gate Pass's issuing department must belong to the Gate Pass's own
  // site — this is exactly the invariant Fix #1/#2's service-layer checks
  // (resolveCreateDepartmentId / assertDepartmentUsable) already enforce.
  pgm.addConstraint("gate_passes", "gate_passes_department_site_fkey", {
    foreignKeys: {
      columns: ["issuing_department_id", "site_id"],
      references: "departments(id, site_id)",
    },
  });

  // Evidence file ownership: a Gate Pass's departure/return photo pointer
  // must reference a gate_pass_files row that actually belongs to THAT
  // Gate Pass — not a photo uploaded against a different one.
  pgm.addConstraint("gate_pass_files", "gate_pass_files_id_gate_pass_id_key", {
    unique: ["id", "gate_pass_id"],
  });
  pgm.addConstraint("gate_passes", "gate_passes_departure_photo_ownership_fkey", {
    foreignKeys: {
      columns: ["departure_photo_file_id", "id"],
      references: "gate_pass_files(id, gate_pass_id)",
    },
  });
  pgm.addConstraint("gate_passes", "gate_passes_return_photo_ownership_fkey", {
    foreignKeys: {
      columns: ["return_photo_file_id", "id"],
      references: "gate_pass_files(id, gate_pass_id)",
    },
  });

  // Uniqueness the application already maintains by construction, now
  // guaranteed even against a bug or a raw script.
  pgm.addConstraint("gate_pass_items", "gate_pass_items_gate_pass_id_line_no_key", {
    unique: ["gate_pass_id", "line_no"],
  });
  pgm.addConstraint("gate_pass_files", "gate_pass_files_gate_pass_id_type_version_key", {
    unique: ["gate_pass_id", "file_type", "version"],
  });
}

export async function down(pgm) {
  pgm.dropConstraint("gate_pass_files", "gate_pass_files_gate_pass_id_type_version_key");
  pgm.dropConstraint("gate_pass_items", "gate_pass_items_gate_pass_id_line_no_key");
  pgm.dropConstraint("gate_passes", "gate_passes_return_photo_ownership_fkey");
  pgm.dropConstraint("gate_passes", "gate_passes_departure_photo_ownership_fkey");
  pgm.dropConstraint("gate_pass_files", "gate_pass_files_id_gate_pass_id_key");
  pgm.dropConstraint("gate_passes", "gate_passes_department_site_fkey");
  pgm.dropConstraint("users", "users_department_site_fkey");
  pgm.dropConstraint("departments", "departments_id_site_id_key");
}
