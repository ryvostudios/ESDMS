export const shorthands = undefined;

// Forced first-login password change for HR-provisioned Employee logins
// (docs/DECISIONS.md). Defaults to false, so every existing account
// (ADMIN/SITE_MANAGER/TEAM_LEAD/GATE_GUARD, CEO/UM/HR bootstrapped
// accounts) is completely unaffected — this column is only ever set true
// by employees.service.js's createLoginForEmployee/resetEmployeeLoginPassword.
export async function up(pgm) {
  pgm.addColumn("users", {
    must_change_password: { type: "boolean", notNull: true, default: false },
  });
}

export async function down(pgm) {
  pgm.dropColumns("users", ["must_change_password"]);
}
