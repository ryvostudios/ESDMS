import pool from "../../config/database.js";
import { listUserProfiles, isProfileActive } from "../users/user-profile.repository.js";

// Answers "which ACTIVE users are actually eligible to perform this
// workflow action right now?" — reusing getUserProfileById (the single
// authoritative effective-permissions computation authenticate.js and the
// governance endpoints already share) rather than a second, hand-rolled
// SQL implementation of the same GRANT/DENY rule that could silently
// diverge from it (see docs/DECISIONS.md).
//
// Eligibility: the profile is active (isProfileActive — user, role, AND
// site all active) AND effectively holds `capabilityCode` (role grant or
// individual GRANT, minus individual DENY) AND is in scope: CEO, or holds
// `allScopePermissionCode` (if given), or belongs to `siteId`.
//
// `departmentId` (optional) narrows a notification to the users who own that
// department's work — the Team Lead of the department a delivery belongs to,
// not every capable user at the site. A broad-scope holder (CEO /
// allScopePermissionCode) stays eligible regardless, exactly as with site
// scope; everyone else must match BOTH site and department. Omitting it
// preserves the original site-only behavior byte for byte.
//
// Profiles for all users are loaded in one set-oriented query using the same
// authoritative projection as authentication. The optional executor keeps
// routing inside the caller's transaction instead of acquiring another pool
// connection while one is already held.
export async function resolveEligibleRecipients({
  capabilityCode,
  allScopePermissionCode = null,
  siteId,
  departmentId = null,
  executor = pool,
}) {
  const profiles = await listUserProfiles(executor);

  const eligible = [];

  for (const profile of profiles) {
    if (!isProfileActive(profile)) continue;
    if (!profile.permissions.includes(capabilityCode)) continue;

    const hasBroadScope =
      profile.role === "CEO" || (allScopePermissionCode && profile.permissions.includes(allScopePermissionCode));

    if (!hasBroadScope && profile.site_id !== siteId) continue;
    if (!hasBroadScope && departmentId && profile.department_id !== departmentId) continue;

    eligible.push(profile.id);
  }

  return eligible;
}
