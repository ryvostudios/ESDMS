export const shorthands = undefined;

// The FORMAL_APPROVER bundle could not perform a formal approval.
//
// It granted exactly one permission, `demand.approve`, but the final approval
// gate requires two:
//
//   recordFinalApprovalDecision (material-demand.service.js):
//     if (!actor.permissions.has(permission) ||
//         !actor.permissions.has(PRICE_VIEW_PERMISSION)) throw new ForbiddenError();
//
// So a user assigned exactly the bundle that exists to make them a Formal
// Approver passed the INITIAL gate and then dead-ended at the FINAL gate with
// a bare 403 — and, because the frontend hides the action when price
// visibility is absent, with no button and no explanation either. Every
// Demand stalled at PENDING_FINAL_APPROVAL until someone with broader
// authority intervened, defeating the separation of duties the bundle exists
// to create.
//
// Authoritative intent is unambiguous and consistent across sources: the
// bundle's own display name is "Formal / Financial Approver", its description
// is "Formal Demand approval authority, kept separate from Procurement
// operations", and docs/OPERATIONS.md lists it as the assignment that makes
// someone a formal approver. The final gate IS the formal Demand approval.
// docs/DECISIONS.md's "grants only demand.approve and stays separate"
// describes what it must stay separate FROM — Procurement operations — not a
// requirement that the approver be unable to approve.
//
// The fix is therefore the single missing FIELD-VISIBILITY permission and
// nothing else. Approving a priced Demand is a decision about an amount, so
// seeing the amount is intrinsic to the job.
//
// What this deliberately does NOT grant, so the bundle stays separate from
// Procurement operations:
//
//   procurement.pricing    — entering prices is Procurement's job, and the
//                            pricing WORK QUEUE stays gated on it
//   procurement.purchase   — purchasing is Procurement's job
//   procurement.site_scope — not needed: demand.approve already confers the
//                            site tier (material-demand.authorization.js)
//   ipo.cancel             — cancelling an IPO is a separate authority
//
// Scope is unchanged. procurement.view_prices is deliberately excluded from
// SITE_WIDE_PERMISSIONS in supply-chain-scope.js and from
// hasSiteWideDemandAuthority in material-demand.authorization.js, so it
// answers "which COLUMNS may this actor see on records they can already
// reach", never "which RECORDS". The holder's site/department reach after
// this migration is identical to before it.

export async function up(pgm) {
  pgm.sql(`
    INSERT INTO permission_bundle_permissions (bundle_id, permission_id)
    SELECT b.id, p.id
    FROM permission_bundles b
    JOIN permissions p ON p.code = 'procurement.view_prices'
    WHERE b.code = 'FORMAL_APPROVER'
    ON CONFLICT DO NOTHING;
  `);
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM permission_bundle_permissions bp
    USING permission_bundles b, permissions p
    WHERE bp.bundle_id = b.id
      AND bp.permission_id = p.id
      AND b.code = 'FORMAL_APPROVER'
      AND p.code = 'procurement.view_prices';
  `);
}
