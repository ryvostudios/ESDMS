import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDemand } from "../hooks/useDemand.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { submitDemand, recordManagementReview, recordFormalApproval } from "../api.js";
import { DemandStatusBadge } from "../components/DemandStatusBadge.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { AuditTimeline } from "../components/AuditTimeline.jsx";
import { ApprovalPanel } from "../components/ApprovalPanel.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { usePricing } from "../../procurement/hooks/usePricing.js";
import { PricingSummary } from "../../procurement/components/PricingSummary.jsx";
import { FinalApprovalPanel } from "../../procurement/components/FinalApprovalPanel.jsx";
import { LineDispositionPanel } from "../../procurement/components/LineDispositionPanel.jsx";
import { downloadBlob } from "../../../shared/utilities/download.js";
import { getDemandPdf } from "../api.js";
import styles from "./DemandDetailPage.module.css";

const EDITABLE_STATUSES = ["DRAFT"];
const SUBMITTABLE_STATUSES = ["DRAFT"];
const PENDING_NOTICE = {
  PENDING_INITIAL_REVIEW: "This Demand has been submitted and is pending initial review. It can no longer be edited.",
  REJECTED: "This Demand was rejected during initial review.",
  READY_FOR_PRICING: "This Demand has completed initial approval and is ready for Procurement pricing.",
  PENDING_FINAL_APPROVAL: "Pricing is complete and this Demand is pending final management review and formal approval.",
  PRICING_REVISION_REQUIRED: "Submitted pricing was rejected at the final gate and requires a new immutable Pricing version.",
  READY_FOR_IPO: "Final pricing approval is complete. The official IPO is being generated.",
  IPO_GENERATED:
    "Final approval is complete and the official IPO has been generated. Procurement now purchases against it.",
  IPO_CANCELLED: "The IPO generated from this Demand was cancelled. Its number and history are preserved.",
  COMPLETED:
    "The Demand, procurement and receiving workflow is complete. This does not mean the material has been consumed — ESDMS does not track stock levels.",
};

function DemandPricingSection({ demandId, reloadDemand }) {
  const { result, status, error, reload } = usePricing(demandId);

  if (status === "loading") return <LoadingState message="Loading protected pricing…" />;
  if (status === "error") return <ErrorState message={error} onRetry={() => reload().catch(() => {})} />;
  return (
    <>
      <PricingSummary detail={result} />
      {/* Line-by-line purchasing decisions come BEFORE the final decision:
          the approver must see, and be bound to, exactly the set they
          approve. */}
      <LineDispositionPanel
        detail={result}
        onChanged={async () => {
          await Promise.all([reload(), reloadDemand()]);
        }}
      />
      <FinalApprovalPanel
        detail={result}
        onChanged={async () => {
          await Promise.all([reload(), reloadDemand()]);
        }}
      />
    </>
  );
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

  const { demand, lines, auditLog, approvals, dispositions = [] } = result;
  // Latest decision per line — a Demand can have several Pricing versions,
  // and only the most recent one describes the current purchasing set.
  const dispositionByLine = new Map(dispositions.map((entry) => [entry.demand_line_id, entry]));
  const canEdit = EDITABLE_STATUSES.includes(demand.status) && hasPermission("demand.edit");
  const canSubmit = SUBMITTABLE_STATUSES.includes(demand.status) && hasPermission("demand.submit");
  const canPrice = demand.status === "READY_FOR_PRICING" && hasPermission("procurement.pricing");
  const canViewSubmittedPrices =
    ["PENDING_FINAL_APPROVAL", "PRICING_REVISION_REQUIRED", "READY_FOR_IPO", "IPO_GENERATED", "IPO_CANCELLED", "COMPLETED"].includes(
      demand.status,
    ) &&
    hasPermission("procurement.view_prices", "procurement.pricing");

  const isPendingReview = demand.status === "PENDING_INITIAL_REVIEW";
  const initialApprovals = approvals.filter((approval) => (approval.approval_stage || "INITIAL") === "INITIAL");
  const hasManagementReview = initialApprovals.some((a) => a.approval_type === "MANAGEMENT_REVIEW");
  const hasFormalApproval = initialApprovals.some((a) => a.approval_type === "FORMAL_APPROVAL");
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
          <Button
            variant="secondary"
            onClick={async () => {
              await downloadBlob(
                await getDemandPdf(id),
                `${demand.demand_number.replaceAll("/", "-")}.pdf`,
              );
            }}
          >
            Download Demand PDF
          </Button>
          {result.ipo && (
            <Button variant="secondary" onClick={() => navigate(`/ipos/${result.ipo.id}`)}>
              View {result.ipo.ipo_number}
            </Button>
          )}
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
                    <th>Purchasing decision</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => {
                    // Visible to the department itself: knowing a line was
                    // excluded (and broadly why) is what lets them decide
                    // whether to carry it forward. The financial explanation
                    // stays behind the price gate, server-side.
                    const decision = dispositionByLine.get(line.id);
                    return (
                      <tr key={line.id}>
                        <td>{line.item_name_snapshot}</td>
                        <td>{line.requested_quantity}</td>
                        <td>{line.uom_name_snapshot}</td>
                        <td>
                          {decision?.disposition === "EXCLUDED" ? (
                            <StatusBadge
                              tone="danger"
                              label={`Excluded — ${(decision.exclusion_category || "")
                                .replaceAll("_", " ")
                                .toLowerCase()}`}
                            />
                          ) : (
                            "—"
                          )}
                        </td>
                      </tr>
                    );
                  })}
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
              <DemandPricingSection demandId={id} reloadDemand={reload} />
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
