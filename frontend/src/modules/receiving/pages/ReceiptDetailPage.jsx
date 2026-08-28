import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState } from "../../../shared/components/StatePanel.jsx";
import { RecordErrorState } from "../../../shared/components/RecordErrorState.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { acknowledgeHandover, confirmReceipt, getReceipt } from "../api.js";
import { RECEIPT_STATUS_LABEL, RECEIPT_STATUS_TONE } from "../../ipo/constants.js";
import styles from "../../ipo/pages/IpoDetailPage.module.css";

export function ReceiptDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const [state, setState] = useState({ result: null, status: "loading", error: null });
  const [dialog, setDialog] = useState(null);

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return getReceipt(id)
      .then((response) => setState({ result: response.data, status: "ready", error: null }))
      .catch((error) =>
        setState({ result: null, status: "error", error }),
      );
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (state.status === "loading") return <LoadingState message="Loading receipt…" />;
  if (state.status === "error")
    return <RecordErrorState error={state.error} onRetry={load} fallback="Unable to load this receipt." />;

  const { receipt, lines } = state.result;
  const awaitingHandover = receipt.status === "AWAITING_HANDOVER";
  const pendingConfirmation = receipt.status === "PENDING_CONFIRMATION";
  const canAcknowledge = awaitingHandover && hasPermission("receiving.receive");
  const canConfirm = pendingConfirmation && hasPermission("receiving.confirm");

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={styles.number}>{receipt.dc_number}</h1>
          <div className={styles.subtitle}>
            <StatusBadge
              tone={RECEIPT_STATUS_TONE[receipt.status]}
              label={RECEIPT_STATUS_LABEL[receipt.status]}
            />
            {receipt.has_discrepancy && <StatusBadge tone="danger" label="Discrepancy recorded" />}
            <span>{receipt.department_name}</span>
            <Link to={`/receiving/challans/${receipt.dc_id}`}>Delivery</Link>
          </div>
        </div>
        <div className={styles.actions}>
          {canAcknowledge && <Button onClick={() => setDialog("handover")}>Acknowledge handover</Button>}
          {canConfirm && <Button onClick={() => setDialog("confirm")}>Confirm completion</Button>}
        </div>
      </div>

      {awaitingHandover && (
        <p className={styles.notice}>
          Admin is holding this material temporarily on behalf of {receipt.department_name}. Someone from the
          department acknowledges the handover once it is physically collected; the original Admin receiver is
          kept on record permanently.
        </p>
      )}
      {pendingConfirmation && (
        <p className={styles.notice}>
          Waiting for the department&apos;s Team Lead to confirm and close this receiving cycle.
        </p>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Custody</h2>
        <dl className={styles.detailGrid}>
          <div>
            <dt>Type</dt>
            <dd>{receipt.receipt_type === "ADMIN_FALLBACK" ? "Temporary Admin custody" : "Department receipt"}</dd>
          </div>
          <div>
            <dt>Recorded by</dt>
            <dd>{receipt.received_by_name}</dd>
          </div>
          <div>
            <dt>Physical receiver</dt>
            <dd>{receipt.physical_receiver_name || "—"}</dd>
          </div>
          <div>
            <dt>Received at</dt>
            <dd>{formatDateTime(receipt.received_at)}</dd>
          </div>
          <div>
            <dt>Handed over to</dt>
            <dd>{receipt.handover_to_name || "—"}</dd>
          </div>
          <div>
            <dt>Handover at</dt>
            <dd>{receipt.handover_at ? formatDateTime(receipt.handover_at) : "—"}</dd>
          </div>
          <div>
            <dt>Confirmed by</dt>
            <dd>{receipt.confirmed_by_name || "—"}</dd>
          </div>
          <div>
            <dt>Confirmed at</dt>
            <dd>{receipt.confirmed_at ? formatDateTime(receipt.confirmed_at) : "—"}</dd>
          </div>
        </dl>
        {receipt.note && <p className={styles.empty}>Note: {receipt.note}</p>}
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
                <th scope="col">Type</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.item_name_snapshot}</td>
                  <td>{line.uom_name_snapshot}</td>
                  <td>{line.dc_quantity}</td>
                  <td>{line.received_quantity}</td>
                  <td>{line.discrepancy_quantity}</td>
                  <td>{line.discrepancy_type ? line.discrepancy_type.replaceAll("_", " ") : "—"}</td>
                  <td>{line.discrepancy_note || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className={styles.empty}>
          This records what physically arrived. It is not a stock balance — ESDMS does not yet track material
          consumption.
        </p>
      </section>

      <ConfirmActionDialog
        open={dialog === "handover"}
        onClose={() => setDialog(null)}
        title="Acknowledge handover?"
        message="This records that your department has physically taken the material from Admin. The original Admin receiver and time remain on record."
        confirmLabel="Acknowledge"
        onConfirm={async () => {
          await acknowledgeHandover(id);
          await load();
        }}
      />
      <ConfirmActionDialog
        open={dialog === "confirm"}
        onClose={() => setDialog(null)}
        title="Confirm this receipt?"
        message="This closes the receiving cycle for these quantities. Any discrepancy recorded stays visible in history."
        confirmLabel="Confirm"
        onConfirm={async () => {
          await confirmReceipt(id);
          await load();
        }}
      />
    </div>
  );
}
