export const shorthands = undefined;

// Simplest revocation mechanism that still gives a real guarantee: a JWT
// carries the session_version it was issued under (claim "sv"); every
// authenticated request compares that to the user's current value. Logout
// bumps it, which makes every previously issued token for that user —
// including one an attacker captured earlier — fail the next check. This
// is coarser than a per-device sessions table (logout ends every session
// for that user, not just the current one), which is an accepted, simpler
// trade-off explicitly allowed for this fix, and is arguably the right
// default for a shared/kiosk Guard device.
export async function up(pgm) {
  pgm.addColumn("users", {
    session_version: { type: "integer", notNull: true, default: 1 },
  });
}

export async function down(pgm) {
  pgm.dropColumns("users", ["session_version"]);
}
