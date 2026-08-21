import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useGatePass } from "../hooks/useGatePass.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { submitGatePass, approveGatePass, rejectGatePass, cancelGatePass, downloadGatePassPdf } from "../api.js";
import { GatePassStatusBadge } from "../components/GatePassStatusBadge.jsx";
import { AuditTimeline } from "../components/AuditTimeline.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import styles from "./GatePassDetailPage.module.css";

const EDITABLE_STATUSES = ["DRAFT"];
const SUBMITTABLE_STATUSES = ["DRAFT"];
const APPROVE_REJECT_STATUSES = ["DRAFT", "PENDING_APPROVAL"];
const CANCELLABLE_STATUSES = ["DRAFT", "PENDING_APPROVAL", "APPROVED"];
const PDF_AVAILABLE_STATUSES = ["APPROVED", "VEHICLE_OUTSIDE", "COMPLETED"];

function DetailField({ label, value }) {
  return (
    <div className={styles.detailItem}>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

export function GatePassDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { gatePass, status, error, reload } = useGatePass(id);

  const [activeDialog, setActiveDialog] = useState(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState(null);

  if (status === "loading") {
    return <LoadingState message="Loading Gate Pass…" />;
  }

  if (status === "error") {
    return <ErrorState message={error} onRetry={reload} />;
  }

  const canEdit = EDITABLE_STATUSES.includes(gatePass.status) && hasPermission("gate_pass.edit_draft");
  const canSubmit = SUBMITTABLE_STATUSES.includes(gatePass.status) && hasPermission("gate_pass.submit");
  const canApprove = APPROVE_REJECT_STATUSES.includes(gatePass.status) && hasPermission("gate_pass.approve");
  const canReject = APPROVE_REJECT_STATUSES.includes(gatePass.status) && hasPermission("gate_pass.reject");
  const canCancel = CANCELLABLE_STATUSES.includes(gatePass.status) && hasPermission("gate_pass.cancel");
  const canDownloadPdf = PDF_AVAILABLE_STATUSES.includes(gatePass.status);

  async function handleSubmit() {
    await submitGatePass(id);
    await reload();
  }

  async function handleApprove() {
    await approveGatePass(id);
    await reload();
  }

  async function handleReject(reason) {
    await rejectGatePass(id, reason);
    await reload();
  }

  async function handleCancel(reason) {
    await cancelGatePass(id, reason);
    await reload();
  }

  async function handleDownloadPdf() {
    setPdfLoading(true);
    setPdfError(null);

    try {
      const blob = await downloadGatePassPdf(id);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank", "noopener");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (downloadError) {
      setPdfError(downloadError.message || "Unable to download the PDF.");
    } finally {
      setPdfLoading(false);
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div className={styles.headingGroup}>
          <h1 className={styles.number}>{gatePass.gatePassNumber}</h1>
          <div className={styles.subtitle}>
            <GatePassStatusBadge status={gatePass.status} /> &nbsp;·&nbsp; Created{" "}
            {new Date(gatePass.createdAt).toLocaleString()}
          </div>
        </div>
        <div className={styles.actions}>
          {canEdit && (
            <Button variant="secondary" onClick={() => navigate(`/gate-passes/${id}/edit`)}>
              Edit
            </Button>
          )}
          {canDownloadPdf && (
            <Button variant="secondary" onClick={handleDownloadPdf} loading={pdfLoading}>
              View PDF
            </Button>
          )}
          {canCancel && (
            <Button variant="secondary" onClick={() => setActiveDialog("cancel")}>
              Cancel
            </Button>
          )}
          {canReject && (
            <Button variant="danger" onClick={() => setActiveDialog("reject")}>
              Reject
            </Button>
          )}
          {canApprove && <Button onClick={() => setActiveDialog("approve")}>Approve</Button>}
          {canSubmit && (
            <Button onClick={() => setActiveDialog("submit")}>Submit for Approval</Button>
          )}
        </div>
      </div>

      {pdfError && <p className={styles.pdfError}>{pdfError}</p>}

      <div className={styles.layout}>
        <div>
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Details</h2>
            <dl className={styles.detailGrid}>
              <DetailField label="Issuing Department" value={gatePass.issuingDepartmentName} />
              <DetailField label="Requested By" value={gatePass.requestedBy} />
              <DetailField label="Destination" value={gatePass.destination} />
              <DetailField label="Purpose" value={formatEnumLabel(gatePass.purpose)} />
              <DetailField label="Driver" value={`${gatePass.driverName} (${gatePass.driverPhone})`} />
              <DetailField label="Vehicle Registration" value={gatePass.vehicleRegistration} />
              <DetailField label="Job Order ID" value={gatePass.jobOrderId} />
              <DetailField
                label="Expected Return Date"
                value={gatePass.expectedReturnDate ? new Date(gatePass.expectedReturnDate).toLocaleDateString() : null}
              />
              <DetailField label="Created By" value={gatePass.createdByName} />
              <DetailField label="Approved By" value={gatePass.approvedByName} />
              {gatePass.remarks && <DetailField label="Remarks" value={gatePass.remarks} />}
              {gatePass.rejectionReason && <DetailField label="Rejection Reason" value={gatePass.rejectionReason} />}
              {gatePass.cancellationReason && <DetailField label="Cancellation Reason" value={gatePass.cancellationReason} />}
            </dl>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Items</h2>
            <table className={styles.itemsTable}>
              <thead>
                <tr>
                  <th>Description</th>
                  <th>Part Number</th>
                  <th>Quantity</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {gatePass.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.description}</td>
                    <td>{item.partNumber || "—"}</td>
                    <td>{item.quantity}</td>
                    <td>{item.unit || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(gatePass.departureOdometer !== null || gatePass.returnOdometer !== null) && (
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>Gate Activity</h2>
              <dl className={styles.detailGrid}>
                <DetailField label="Departure Odometer" value={gatePass.departureOdometer} />
                <DetailField label="Departure Time" value={gatePass.departureAt ? new Date(gatePass.departureAt).toLocaleString() : null} />
                <DetailField label="Return Odometer" value={gatePass.returnOdometer} />
                <DetailField label="Return Time" value={gatePass.returnAt ? new Date(gatePass.returnAt).toLocaleString() : null} />
                <DetailField label="Distance" value={gatePass.distanceKm !== null ? `${gatePass.distanceKm} km` : null} />
                {gatePass.returnRemarks && <DetailField label="Return Remarks" value={gatePass.returnRemarks} />}
              </dl>
            </div>
          )}
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Audit Timeline</h2>
          <AuditTimeline entries={gatePass.auditLog} />
        </div>
      </div>

      <ConfirmActionDialog
        open={activeDialog === "submit"}
        onClose={() => setActiveDialog(null)}
        title="Submit for approval?"
        message="This Gate Pass will move to Pending Approval and can no longer be edited."
        confirmLabel="Submit"
        onConfirm={handleSubmit}
      />
      <ConfirmActionDialog
        open={activeDialog === "approve"}
        onClose={() => setActiveDialog(null)}
        title="Approve this Gate Pass?"
        message="Approving will generate the issued Gate Pass PDF and notify the gate."
        confirmLabel="Approve"
        onConfirm={handleApprove}
      />
      <ReasonActionDialog
        open={activeDialog === "reject"}
        onClose={() => setActiveDialog(null)}
        title="Reject this Gate Pass?"
        message="Provide a reason for the requester."
        confirmLabel="Reject"
        onConfirm={handleReject}
      />
      <ReasonActionDialog
        open={activeDialog === "cancel"}
        onClose={() => setActiveDialog(null)}
        title="Cancel this Gate Pass?"
        message="This cannot be undone once the vehicle has left the site."
        confirmLabel="Cancel Gate Pass"
        onConfirm={handleCancel}
      />
    </div>
  );
}
