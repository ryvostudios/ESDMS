import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useDemand } from "../hooks/useDemand.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { submitDemand } from "../api.js";
import { DemandStatusBadge } from "../components/DemandStatusBadge.jsx";
import { AuditTimeline } from "../components/AuditTimeline.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import styles from "./DemandDetailPage.module.css";

const EDITABLE_STATUSES = ["DRAFT"];
const SUBMITTABLE_STATUSES = ["DRAFT"];

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
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);

  if (status === "loading") {
    return <LoadingState message="Loading Demand…" />;
  }

  if (status === "error") {
    return <ErrorState message={error} onRetry={reload} />;
  }

  const { demand, lines, auditLog } = result;
  const canEdit = EDITABLE_STATUSES.includes(demand.status) && hasPermission("demand.edit");
  const canSubmit = SUBMITTABLE_STATUSES.includes(demand.status) && hasPermission("demand.submit");

  async function handleSubmit() {
    await submitDemand(id);
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
          {canSubmit && <Button onClick={() => setConfirmSubmitOpen(true)}>Submit for Review</Button>}
        </div>
      </div>

      {demand.status === "PENDING_INITIAL_REVIEW" && (
        <p className={styles.pendingNotice}>
          This Demand has been submitted and is pending management review. It can no longer be edited.
        </p>
      )}

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
        </div>

        <div className={styles.section}>
          <h2 className={styles.sectionTitle}>Audit Timeline</h2>
          <AuditTimeline entries={auditLog} />
        </div>
      </div>

      <ConfirmActionDialog
        open={confirmSubmitOpen}
        onClose={() => setConfirmSubmitOpen(false)}
        title="Submit for review?"
        message="This Demand will move to pending management review and can no longer be edited."
        confirmLabel="Submit"
        onConfirm={handleSubmit}
      />
    </div>
  );
}
