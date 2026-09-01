import { useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { ApprovalPanel } from "../../material-demand/components/ApprovalPanel.jsx";
import {
  recordFinalFormalApproval,
  recordFinalManagementReview,
} from "../../material-demand/api.js";

export function FinalApprovalPanel({ detail, onChanged }) {
  const { user, hasPermission } = useAuth();
  const [activeDialog, setActiveDialog] = useState(null);
  const approvals = detail.finalApprovals || [];
  const management = approvals.find((approval) => approval.approval_type === "MANAGEMENT_REVIEW");
  const formal = approvals.find((approval) => approval.approval_type === "FORMAL_APPROVAL");
  const pending = detail.demand.status === "PENDING_FINAL_APPROVAL";
  const hasPriceView = hasPermission("procurement.view_prices");
  const isCeo = user?.role === "CEO";
  const canReview =
    pending &&
    hasPriceView &&
    hasPermission("demand.review") &&
    !management &&
    (isCeo || formal?.actor_user_id !== user?.id);
  const canApprove =
    pending &&
    hasPriceView &&
    hasPermission("demand.approve") &&
    !formal &&
    (isCeo || management?.actor_user_id !== user?.id);

  // The final gate requires the decision permission AND price visibility
  // (recordFinalApprovalDecision in material-demand.service.js). An actor
  // holding only the first used to see nothing at all here — no button, no
  // explanation — while the Demand waited on them. Say so instead.
  const missingPriceView = pending && !hasPriceView;
  const blockedReason = (permission) =>
    missingPriceView && hasPermission(permission)
      ? "Final approval is a decision about an amount, so it also needs price visibility. Ask Governance to grant procurement.view_prices, or assign the Formal / Financial Approver bundle."
      : null;

  async function decide(type, decision, reason) {
    const action = type === "review" ? recordFinalManagementReview : recordFinalFormalApproval;
    await action(detail.demand.id, {
      pricingId: detail.pricing.id,
      decision,
      ...(reason ? { reason } : {}),
    });
    await onChanged();
  }

  return (
    <>
      <ApprovalPanel
        approvals={approvals}
        stage="FINAL"
        title={`Final Pricing Approval · Version ${detail.pricing.version}`}
        canReview={canReview}
        canApprove={canApprove}
        reviewBlockedReason={blockedReason("demand.review")}
        approvalBlockedReason={blockedReason("demand.approve")}
        onReviewDecision={(decision) =>
          setActiveDialog(decision === "APPROVED" ? "review-approve" : "review-reject")
        }
        onApprovalDecision={(decision) =>
          setActiveDialog(decision === "APPROVED" ? "formal-approve" : "formal-reject")
        }
      />

      <ConfirmActionDialog
        open={activeDialog === "review-approve"}
        onClose={() => setActiveDialog(null)}
        title={`Approve Pricing Version ${detail.pricing.version}?`}
        message="This records the final Management Review against this exact submitted Pricing version."
        confirmLabel="Approve"
        onConfirm={() => decide("review", "APPROVED")}
      />
      <ReasonActionDialog
        open={activeDialog === "review-reject"}
        onClose={() => setActiveDialog(null)}
        title={`Reject Pricing Version ${detail.pricing.version}?`}
        message="Provide an internal reason for Procurement. The submitted Pricing version will remain immutable."
        confirmLabel="Reject"
        onConfirm={(reason) => decide("review", "REJECTED", reason)}
      />
      <ConfirmActionDialog
        open={activeDialog === "formal-approve"}
        onClose={() => setActiveDialog(null)}
        title={`Formally approve Pricing Version ${detail.pricing.version}?`}
        message="This records the final Formal/CFO Approval against this exact submitted Pricing version."
        confirmLabel="Approve"
        onConfirm={() => decide("formal", "APPROVED")}
      />
      <ReasonActionDialog
        open={activeDialog === "formal-reject"}
        onClose={() => setActiveDialog(null)}
        title={`Reject Pricing Version ${detail.pricing.version}?`}
        message="Provide an internal reason for Procurement. The submitted Pricing version will remain immutable."
        confirmLabel="Reject"
        onConfirm={(reason) => decide("formal", "REJECTED", reason)}
      />
    </>
  );
}
