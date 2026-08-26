import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDemand } from "../hooks/useDemand.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { submitDemand, recordManagementReview, recordFormalApproval } from "../api.js";
import { DemandStatusBadge } from "../components/DemandStatusBadge.jsx";
import { AuditTimeline } from "../components/AuditTimeline.jsx";
import { ApprovalPanel } from "../components/ApprovalPanel.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { usePricing } from "../../procurement/hooks/usePricing.js";
import { PricingSummary } from "../../procurement/components/PricingSummary.jsx";
import styles from "./DemandDetailPage.module.css";

const EDITABLE_STATUSES = ["DRAFT"];
const SUBMITTABLE_STATUSES = ["DRAFT"];
const PENDING_NOTICE = {
  PENDING_INITIAL_REVIEW: "This Demand has been submitted and is pending initial review. It can no longer be edited.",
  REJECTED: "This Demand was rejected during initial review.",
  READY_FOR_PRICING: "This Demand has completed initial approval and is ready for Procurement pricing.",
  PENDING_FINAL_APPROVAL: "Pricing is complete and this Demand is pending final management review and formal approval.",
};

function DemandPricingSection({ demandId }) {
  const { result, status, error, reload } = usePricing(demandId);

  if (status === "loading") return <LoadingState message="Loading protected pricing…" />;
  if (status === "error") return <ErrorState message={error} onRetry={() => reload().catch(() => {})} />;
  return <PricingSummary detail={result} />;
}

function DetailField({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

export function DemandDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { result, status, error, reload } = useDemand(id);
  const [activeDialog, setActiveDialog] = useState(null);

  if (status === "loading") {
    return <LoadingState message="Loading Demand…" />;
  }

  if (status === "error") {
    return <ErrorState message={error} onRetry={reload} />;
  }

  const { demand, lines, auditLog, approvals } = result;
  const canEdit = EDITABLE_STATUSES.includes(demand.status) && hasPermission("demand.edit");
  const canSubmit = SUBMITTABLE_STATUSES.includes(demand.status) && hasPermission("demand.submit");
  const canPrice = demand.status === "READY_FOR_PRICING" && hasPermission("procurement.pricing");
  const canViewSubmittedPrices =
    demand.status === "PENDING_FINAL_APPROVAL" &&
    hasPermission("procurement.view_prices", "procurement.pricing");

  const isPendingReview = demand.status === "PENDING_INITIAL_REVIEW";
  const hasManagementReview = approvals.some((a) => a.approval_type === "MANAGEMENT_REVIEW");
  const hasFormalApproval = approvals.some((a) => a.approval_type === "FORMAL_APPROVAL");
  const canReview = isPendingReview && !hasManagementReview && hasPermission("demand.review");
  const canApprove = isPendingReview && !hasFormalApproval && hasPermission("demand.approve");
  const showApprovalPanel = demand.status !== "DRAFT";

  async function handleSubmit() {
    await submitDemand(id);
    await reload();
  }

  async function handleReviewDecision(decision, reason) {
    await recordManagementReview(id, { decision, reason });
    await reload();
  }

  async function handleApprovalDecision(decision, reason) {
    await recordFormalApproval(id, { decision, reason });
    await reload();
  }

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.headingGroup}>
          <h1 className={styles.number}>{demand.demand_number}</h1>
          <div className={styles.subtitle}>
            <DemandStatusBadge status={demand.status} /> &nbsp;·&nbsp; {demand.department_name} &nbsp;·&nbsp; Created{" "}
            {formatDateTime(demand.created_at)}
          </div>
        </div>
        <div className={styles.actions}>
          {canEdit && (
            <Button variant="secondary" onClick={() => navigate(`/demands/${id}/edit`)}>
              Edit
            </Button>
          )}
          {canSubmit && <Button onClick={() => setActiveDialog("submit")}>Submit for Review</Button>}
          {canPrice && <Button onClick={() => navigate(`/procurement/pricing/${id}`)}>Enter Pricing</Button>}
        </div>
      </div>

      {PENDING_NOTICE[demand.status] && <p className={styles.pendingNotice}>{PENDING_NOTICE[demand.status]}</p>}

      <div className={styles.layout}>
        <div>
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Details</h2>
            <dl className={styles.detailGrid}>
              <DetailField label="Department" value={demand.department_name} />
              <DetailField label="Site" value={demand.site_name} />
              <DetailField label="Created By" value={demand.created_by_name} />
              <DetailField label="Submitted" value={demand.submitted_at ? formatDateTime(demand.submitted_at) : null} />
              {demand.note && <DetailField label="Note" value={demand.note} />}
            </dl>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Materials</h2>
            <div className={styles.tableWrapper}>
              <table className={styles.itemsTable}>
                <thead>
                  <tr>
                    <th>Material</th>
                    <th>Quantity</th>
                    <th>Unit</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id}>
                      <td>{line.item_name_snapshot}</td>
                      <td>{line.requested_quantity}</td>
                      <td>{line.uom_name_snapshot}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {showApprovalPanel && (
            <div className={styles.section}>
              <ApprovalPanel
                approvals={approvals}
                canReview={canReview}
                canApprove={canApprove}
                onReviewDecision={(decision) =>
                  decision === "APPROVED" ? setActiveDialog("review-approve") : setActiveDialog("review-reject")
                }
                onApprovalDecision={(decision) =>
                  decision === "APPROVED" ? setActiveDialog("approval-approve") : setActiveDialog("approval-reject")
                }
              />
            </div>
          )}

          {canViewSubmittedPrices && (
            <div className={styles.section}>
              <DemandPricingSection demandId={id} />
            </div>
          )}
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Audit Timeline</h2>
          <AuditTimeline entries={auditLog} />
        </div>
      </div>

      <ConfirmActionDialog
        open={activeDialog === "submit"}
        onClose={() => setActiveDialog(null)}
        title="Submit for review?"
        message="This Demand will move to pending initial review and can no longer be edited."
        confirmLabel="Submit"
        onConfirm={handleSubmit}
      />
      <ConfirmActionDialog
        open={activeDialog === "review-approve"}
        onClose={() => setActiveDialog(null)}
        title="Approve Management Review?"
        message="This records your approval for the Management Review stage."
        confirmLabel="Approve"
        onConfirm={() => handleReviewDecision("APPROVED")}
      />
      <ReasonActionDialog
        open={activeDialog === "review-reject"}
        onClose={() => setActiveDialog(null)}
        title="Reject this Demand?"
        message="Provide a reason for the requester."
        confirmLabel="Reject"
        onConfirm={(reason) => handleReviewDecision("REJECTED", reason)}
      />
      <ConfirmActionDialog
        open={activeDialog === "approval-approve"}
        onClose={() => setActiveDialog(null)}
        title="Record Formal Approval?"
        message="This records the formal/financial approval for this stage."
        confirmLabel="Approve"
        onConfirm={() => handleApprovalDecision("APPROVED")}
      />
      <ReasonActionDialog
        open={activeDialog === "approval-reject"}
        onClose={() => setActiveDialog(null)}
        title="Reject this Demand?"
        message="Provide a reason for the requester."
        confirmLabel="Reject"
        onConfirm={(reason) => handleApprovalDecision("REJECTED", reason)}
      />
    </div>
  );
}
