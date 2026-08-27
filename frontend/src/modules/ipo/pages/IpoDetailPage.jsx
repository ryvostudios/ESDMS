import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { downloadBlob } from "../../../shared/utilities/download.js";
import { formatPkr } from "../../procurement/utilities/money.js";
import { useIpo } from "../hooks/useIpo.js";
import { acknowledgeIpo, cancelIpo, closePurchasing, getIpoPdf, recordPurchase } from "../api.js";
import { createDeliveryChallan } from "../../delivery-challan/api.js";
import { PurchasePanel } from "../components/PurchasePanel.jsx";
import { CreateChallanDialog } from "../components/CreateChallanDialog.jsx";
import {
  DC_STATUS_TONE,
  IPO_STATUS_TONE,
  PURCHASE_STATUS_LABEL,
  PURCHASE_STATUS_TONE,
  RECEIPT_STATUS_LABEL,
  RECEIPT_STATUS_TONE,
} from "../constants.js";
import styles from "./IpoDetailPage.module.css";

const CLOSED_STATUSES = ["COMPLETED", "CANCELLED"];

function Field({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

export function IpoDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const { result, status, error, reload } = useIpo(id);
  const [dialog, setDialog] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (status === "loading") return <LoadingState message="Loading IPO…" />;
  if (status === "error") return <ErrorState message={error} onRetry={reload} />;

  const { ipo, lines, auditLog, deliveryChallans, receipts, includesCommercialData } = result;
  const canPurchase = hasPermission("procurement.purchase");
  const canManageChallans = hasPermission("dc.manage");
  const canCancel = hasPermission("ipo.cancel");
  const isClosed = CLOSED_STATUSES.includes(ipo.status);
  const purchasingClosed = Boolean(ipo.purchasing_closed_at);

  async function handleDownload() {
    setActionError(null);
    try {
      await downloadBlob(await getIpoPdf(id), `${ipo.ipo_number.replaceAll("/", "-")}.pdf`);
    } catch (downloadError) {
      setActionError(downloadError.message || "Unable to download the IPO document.");
    }
  }

  return (
    <div>
      <div className={styles.header}>
        <div>
          <h1 className={styles.number}>{ipo.ipo_number}</h1>
          <div className={styles.subtitle}>
            <StatusBadge tone={IPO_STATUS_TONE[ipo.status]} label={ipo.status.replaceAll("_", " ")} />
            <span>{ipo.department_name}</span>
            <span>{ipo.site_name}</span>
            <Link to={`/demands/${ipo.demand_id}`}>Demand {ipo.demand_number}</Link>
          </div>
        </div>
        <div className={styles.actions}>
          {/* Shown only to a viewer who may actually see commercial data —
              the backend refuses this download for anyone else regardless. */}
          {includesCommercialData && (
            <Button variant="secondary" onClick={handleDownload}>
              Download IPO PDF
            </Button>
          )}
          {canPurchase && ipo.status === "GENERATED" && (
            <Button variant="secondary" onClick={() => setDialog("acknowledge")}>
              Acknowledge
            </Button>
          )}
          {canManageChallans && !isClosed && (
            <Button onClick={() => setDialog("challan")}>New Delivery Challan</Button>
          )}
          {canPurchase && !isClosed && !purchasingClosed && (
            <Button variant="secondary" onClick={() => setDialog("close-purchasing")}>
              Close purchasing
            </Button>
          )}
          {canCancel && !isClosed && (
            <Button variant="danger" onClick={() => setDialog("cancel")}>
              Cancel IPO
            </Button>
          )}
        </div>
      </div>

      {actionError && (
        <p className={styles.error} role="alert">
          {actionError}
        </p>
      )}

      {ipo.status === "CANCELLED" && (
        <p className={styles.notice}>
          This IPO was cancelled{ipo.cancelled_by_name ? ` by ${ipo.cancelled_by_name}` : ""}
          {ipo.cancelled_at ? ` on ${formatDateTime(ipo.cancelled_at)}` : ""}. Its number remains permanently
          consumed and its history is preserved.
        </p>
      )}
      {purchasingClosed && ipo.status !== "CANCELLED" && (
        <p className={styles.notice}>
          Purchasing is closed. Any approved quantity that was never purchased remains outstanding and can be
          carried forward into a later Demand.
        </p>
      )}
      {ipo.status === "COMPLETED" && (
        <p className={styles.notice}>
          The procurement and receiving workflow for this IPO is complete. This does not mean the material has
          been consumed — ESDMS does not track stock levels.
        </p>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Details</h2>
        <dl className={styles.detailGrid}>
          <Field label="Department" value={ipo.department_name} />
          <Field label="Site" value={ipo.site_name} />
          <Field label="Demand" value={`${ipo.demand_number} (revision ${ipo.demand_revision})`} />
          <Field label="Generated" value={formatDateTime(ipo.generated_at)} />
          <Field label="Generated by" value={ipo.generated_by_name} />
          <Field
            label="Acknowledged"
            value={ipo.acknowledged_at ? `${ipo.acknowledged_by_name} · ${formatDateTime(ipo.acknowledged_at)}` : null}
          />
          {includesCommercialData && (
            <Field label="Approved estimate" value={formatPkr(ipo.estimated_total)} />
          )}
        </dl>
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Lines</h2>
        <div className={styles.tableWrapper}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col">Unit</th>
                <th scope="col">Approved</th>
                <th scope="col">Purchased</th>
                <th scope="col">Outstanding</th>
                <th scope="col">Delivered</th>
                <th scope="col">Received</th>
                <th scope="col">Discrepancy</th>
                {includesCommercialData && <th scope="col">Estimated</th>}
                {includesCommercialData && <th scope="col">Actual</th>}
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>{line.item_name_snapshot}</td>
                  <td>{line.uom_code_snapshot}</td>
                  <td>{line.approved_quantity}</td>
                  <td>{line.purchased_quantity}</td>
                  <td>{line.outstanding_quantity}</td>
                  <td>{line.allocated_quantity}</td>
                  <td>{line.received_quantity}</td>
                  <td>{line.discrepancy_quantity}</td>
                  {includesCommercialData && <td>{formatPkr(line.estimated_unit_price)}</td>}
                  {includesCommercialData && (
                    <td>{line.actual_unit_price ? formatPkr(line.actual_unit_price) : "—"}</td>
                  )}
                  <td>
                    <StatusBadge
                      tone={PURCHASE_STATUS_TONE[line.purchase_status]}
                      label={PURCHASE_STATUS_LABEL[line.purchase_status]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canPurchase && (
        <section className={styles.section}>
          <PurchasePanel
            lines={lines}
            disabled={isClosed || purchasingClosed}
            disabledReason={
              ipo.status === "CANCELLED"
                ? "This IPO is cancelled — no further purchasing can be recorded."
                : purchasingClosed
                  ? "Purchasing has been closed for this IPO."
                  : "This IPO is completed."
            }
            onSave={async (body) => {
              await recordPurchase(id, body);
              await reload();
            }}
          />
        </section>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Delivery Challans</h2>
        {deliveryChallans.length === 0 ? (
          <p className={styles.empty}>No Delivery Challan has been created for this IPO yet.</p>
        ) : (
          <ul className={styles.chain}>
            {deliveryChallans.map((challan) => (
              <li key={challan.id}>
                <Link to={`/delivery-challans/${challan.id}`} className={styles.chainRow}>
                  <div>
                    <strong>{challan.dc_number}</strong>
                    <span>
                      {challan.line_count} {challan.line_count === 1 ? "line" : "lines"} · created{" "}
                      {formatDateTime(challan.created_at)}
                    </span>
                  </div>
                  <StatusBadge
                    tone={DC_STATUS_TONE[challan.status]}
                    label={challan.status.replaceAll("_", " ")}
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Receiving</h2>
        {receipts.length === 0 ? (
          <p className={styles.empty}>Nothing has been received against this IPO yet.</p>
        ) : (
          <ul className={styles.chain}>
            {receipts.map((receipt) => (
              <li key={receipt.id}>
                <Link to={`/receiving/receipts/${receipt.id}`} className={styles.chainRow}>
                  <div>
                    <strong>{receipt.dc_number}</strong>
                    <span>
                      {receipt.receipt_type === "ADMIN_FALLBACK"
                        ? `Temporary Admin custody by ${receipt.received_by_name}`
                        : `Received by ${receipt.received_by_name}`}
                      {receipt.physical_receiver_name ? ` (physically: ${receipt.physical_receiver_name})` : ""} ·{" "}
                      {formatDateTime(receipt.received_at)}
                    </span>
                    {receipt.handover_to_name && (
                      <span>
                        Handed over to {receipt.handover_to_name} · {formatDateTime(receipt.handover_at)}
                      </span>
                    )}
                    {receipt.confirmed_by_name && (
                      <span>
                        Confirmed by {receipt.confirmed_by_name} · {formatDateTime(receipt.confirmed_at)}
                      </span>
                    )}
                  </div>
                  <div className={styles.chainBadges}>
                    <StatusBadge
                      tone={RECEIPT_STATUS_TONE[receipt.status]}
                      label={RECEIPT_STATUS_LABEL[receipt.status]}
                    />
                    {receipt.has_discrepancy && <StatusBadge tone="danger" label="Discrepancy" />}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>History</h2>
        <ol className={styles.timeline}>
          {auditLog.map((entry) => (
            <li key={entry.id}>
              <strong>{entry.action.replaceAll("_", " ")}</strong>
              <span>
                {entry.actor_name} · {formatDateTime(entry.created_at)}
              </span>
            </li>
          ))}
        </ol>
      </section>

      <ConfirmActionDialog
        open={dialog === "acknowledge"}
        onClose={() => setDialog(null)}
        title="Acknowledge this IPO?"
        message="This records that Procurement has received the IPO. It does not begin purchasing."
        confirmLabel="Acknowledge"
        onConfirm={async () => {
          await acknowledgeIpo(id);
          await reload();
        }}
      />
      <ConfirmActionDialog
        open={dialog === "close-purchasing"}
        onClose={() => setDialog(null)}
        title="Close purchasing for this IPO?"
        message="No further purchasing can be recorded afterwards. Any approved quantity never purchased stays outstanding and can be carried forward into a later Demand."
        confirmLabel="Close purchasing"
        onConfirm={async () => {
          await closePurchasing(id);
          await reload();
        }}
      />
      <ReasonActionDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        title="Cancel this IPO?"
        message="The IPO and its number are preserved permanently. Provide the reason for cancellation."
        confirmLabel="Cancel IPO"
        onConfirm={async (reason) => {
          await cancelIpo(id, { reason });
          await reload();
        }}
      />
      <CreateChallanDialog
        open={dialog === "challan"}
        onClose={() => setDialog(null)}
        lines={lines}
        onCreate={async (body) => {
          const response = await createDeliveryChallan({ ipoId: id, ...body });
          navigate(`/delivery-challans/${response.data.deliveryChallan.id}`);
        }}
      />
    </div>
  );
}
