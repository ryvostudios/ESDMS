import pool from "../../config/database.js";
import { selectEligibleRecipientIds } from "../users/user-profile.repository.js";

// Answers "which ACTIVE users are actually eligible to perform this workflow
// action right now?" — reusing the effective-permission and current-assignment
// rules authentication itself uses (see user-profile.repository.js) rather
// than a second, hand-rolled implementation of the same GRANT/DENY/bundle
// precedence that could silently diverge from it.
//
// Eligibility: the profile is active (user, role AND site all active) AND
// effectively holds `capabilityCode` (role grant, individual GRANT or active
// bundle, minus individual DENY) AND is in scope: CEO, or holds
// `allScopePermissionCode` (if given), or belongs to `siteId`.
//
// `departmentId` (optional) narrows a notification to the users who own that
// department's work — the Team Lead of the department a delivery belongs to,
// not every capable user at the site. A broad-scope holder (CEO /
// allScopePermissionCode) stays eligible regardless, exactly as with site
// scope; everyone else must match BOTH site and department. Omitting it
// preserves the site-only behaviour.
//
// The filtering happens in the database, not in JavaScript over every user
// profile: this runs inside the caller's write transaction, while it holds
// its row lock, so its cost must depend on how many recipients there ARE and
// not on how many accounts exist. The optional executor keeps routing inside
// that transaction instead of acquiring another pool connection while one is
// already held.
export async function resolveEligibleRecipients({
  capabilityCode,
  allScopePermissionCode = null,
  siteId,
  departmentId = null,
  executor = pool,
}) {
  return selectEligibleRecipientIds(executor, {
    capabilityCode,
    allScopePermissionCode,
    siteId,
    departmentId,
  });
}
