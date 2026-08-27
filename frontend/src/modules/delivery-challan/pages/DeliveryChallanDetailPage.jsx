import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { downloadBlob } from "../../../shared/utilities/download.js";
import { DC_STATUS_TONE } from "../../ipo/constants.js";
import {
  cancelDeliveryChallan,
  finalizeDeliveryChallan,
  getDeliveryChallan,
  getDeliveryChallanPdf,
} from "../api.js";
import styles from "../../ipo/pages/IpoDetailPage.module.css";

export function DeliveryChallanDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const [state, setState] = useState({ result: null, status: "loading", error: null });
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return getDeliveryChallan(id)
      .then((response) => setState({ result: response.data, status: "ready", error: null }))
      .catch((error) =>
        setState({
          result: null,
          status: "error",
          error: error.message || "Unable to load this Delivery Challan.",
        }),
      );
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (state.status === "loading") return <LoadingState message="Loading Delivery Challan…" />;
  if (state.status === "error") return <ErrorState message={state.error} onRetry={load} />;

  const { deliveryChallan: challan, lines } = state.result;
  const canManage = hasPermission("dc.manage");
  const isDraft = challan.status === "DRAFT";
  const isCancellable = canManage && ["DRAFT", "FINALIZED"].includes(challan.status);

  async function handleDownload() {
    setActionError(null);
    try {
      await downloadBlob(await getDeliveryChallanPdf(id), `${challan.dc_number.replaceAll("/", "-")}.pdf`);
    } catch (downloadError) {
      setActionError(downloadError.message || "Unable to download the Delivery Challan.");
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={styles.number}>{challan.dc_number}</h1>
          <div className={styles.subtitle}>
            <StatusBadge tone={DC_STATUS_TONE[challan.status]} label={challan.status.replaceAll("_", " ")} />
            <span>{challan.department_name}</span>
            <Link to={`/ipos/${challan.ipo_id}`}>{challan.ipo_number}</Link>
          </div>
        </div>
        <div className={styles.actions}>
          <Button variant="secondary" onClick={handleDownload}>
            Download Challan PDF
          </Button>
          {canManage && isDraft && <Button onClick={() => setDialog("finalize")}>Finalize</Button>}
          {isCancellable && (
            <Button variant="danger" onClick={() => setDialog("cancel")}>
              Cancel challan
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      )}

      {isDraft && (
        <p className={styles.notice}>
          This challan is still a draft. Finalize it to make it available for receiving and to share it with the
          department.
        </p>
      )}
      {challan.status === "CANCELLED" && (
        <p className={styles.notice}>
          Cancelled{challan.cancelled_by_name ? ` by ${challan.cancelled_by_name}` : ""}
          {challan.cancellation_reason ? `: ${challan.cancellation_reason}` : ""}. The number remains consumed.
        </p>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Details</h2>
        <dl className={styles.detailGrid}>
          <div>
            <dt>Department</dt>
            <dd>{challan.department_name}</dd>
          </div>
          <div>
            <dt>Site</dt>
            <dd>{challan.site_name}</dd>
          </div>
          <div>
            <dt>IPO</dt>
            <dd>{challan.ipo_number}</dd>
          </div>
          <div>
            <dt>Demand</dt>
            <dd>{challan.demand_number}</dd>
          </div>
          <div>
            <dt>Created by</dt>
            <dd>{challan.created_by_name}</dd>
          </div>
          <div>
            <dt>Finalized</dt>
            <dd>{challan.finalized_at ? formatDateTime(challan.finalized_at) : "—"}</dd>
          </div>
        </dl>
        {challan.note && <p className={styles.empty}>Note: {challan.note}</p>}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Items</h2>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col">Unit</th>
                <th scope="col">Challan qty</th>
                <th scope="col">Received</th>
                <th scope="col">Discrepancy</th>
                <th scope="col">Unresolved</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.item_name_snapshot}</td>
                  <td>{line.uom_name_snapshot}</td>
                  <td>{line.quantity}</td>
                  <td>{line.received_quantity}</td>
                  <td>{line.discrepancy_quantity}</td>
                  <td>{line.unresolved_quantity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.empty}>
          A Delivery Challan is an operational document. It carries no pricing, no approval history and no
          internal Procurement notes.
        </p>
      </section>

      <ConfirmActionDialog
        open={dialog === "finalize"}
        onClose={() => setDialog(null)}
        title="Finalize this Delivery Challan?"
        message="Its items and quantities can no longer be edited, the owning department is notified, and the document is prepared for sharing."
        confirmLabel="Finalize"
        onConfirm={async () => {
          await finalizeDeliveryChallan(id);
          await load();
        }}
      />
      <ReasonActionDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        title="Cancel this Delivery Challan?"
        message="The challan and its number are preserved. This is only possible while nothing has been received against it."
        confirmLabel="Cancel challan"
        onConfirm={async (reason) => {
          await cancelDeliveryChallan(id, { reason });
          await load();
        }}
      />
    </div>
  );
}
