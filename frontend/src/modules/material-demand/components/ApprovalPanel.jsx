import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { APPROVAL_TYPE_LABEL } from "../constants.js";
import styles from "./ApprovalPanel.module.css";

function Slot({ type, approval, canAct, onApprove, onReject }) {
  return (
    <div className={styles.slot}>
      <span className={styles.slotLabel}>{APPROVAL_TYPE_LABEL[type]}</span>

      {approval ? (
        <>
          <StatusBadge
            tone={approval.decision === "APPROVED" ? "success" : "danger"}
            label={approval.decision === "APPROVED" ? `Approved by ${approval.actor_name}` : `Rejected by ${approval.actor_name}`}
          />
          <span className={styles.slotMeta}>{formatDateTime(approval.created_at)}</span>
          {approval.reason && <span className={styles.slotReason}>“{approval.reason}”</span>}
        </>
      ) : (
        <>
          <StatusBadge tone="neutral" label="Pending" />
          {canAct && (
            <div className={styles.slotActions}>
              <Button variant="secondary" onClick={onApprove}>
                Approve
              </Button>
              <Button variant="danger" onClick={onReject}>
                Reject
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Two independent slots — Management Review and Formal Approval — never a
// single combined "approved" flag, so partial progress is always visible
// (see docs/PROCUREMENT_RECEIVING_SPEC.md §15).
export function ApprovalPanel({
  approvals,
  stage = "INITIAL",
  title = "Initial Approval",
  canReview,
  canApprove,
  onReviewDecision,
  onApprovalDecision,
}) {
  const stageApprovals = approvals.filter((approval) => (approval.approval_stage || "INITIAL") === stage);
  const managementReview = stageApprovals.find((a) => a.approval_type === "MANAGEMENT_REVIEW");
  const formalApproval = stageApprovals.find((a) => a.approval_type === "FORMAL_APPROVAL");

  return (
    <div className={styles.panel}>
      <h2 className={styles.title}>{title}</h2>
      <Slot
        type="MANAGEMENT_REVIEW"
        approval={managementReview}
        canAct={canReview}
        onApprove={() => onReviewDecision("APPROVED")}
        onReject={() => onReviewDecision("REJECTED")}
      />
      <Slot
        type="FORMAL_APPROVAL"
        approval={formalApproval}
        canAct={canApprove}
        onApprove={() => onApprovalDecision("APPROVED")}
        onReject={() => onApprovalDecision("REJECTED")}
      />
    </div>
  );
}
