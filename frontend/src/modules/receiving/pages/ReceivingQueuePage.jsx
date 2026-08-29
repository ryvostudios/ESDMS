import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { listOpenDeliveries, listReceipts } from "../api.js";
import { DC_STATUS_TONE, RECEIPT_STATUS_LABEL, RECEIPT_STATUS_TONE } from "../../ipo/constants.js";
import styles from "./ReceivingQueuePage.module.css";

export function ReceivingQueuePage() {
  const [state, setState] = useState({ deliveries: [], pending: [], status: "loading", error: null });

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return Promise.all([
      listOpenDeliveries({ pageSize: 50 }),
      // Everything still waiting on this department: an Admin custody
      // handover to collect, or a receipt waiting for the Team Lead's
      // confirmation.
      listReceipts({ status: "AWAITING_HANDOVER", pageSize: 50 }),
      listReceipts({ status: "PENDING_CONFIRMATION", pageSize: 50 }),
    ])
      .then(([deliveries, handovers, confirmations]) =>
        setState({
          deliveries: deliveries.data,
          pending: [...handovers.data, ...confirmations.data],
          status: "ready",
          error: null,
        }),
      )
      .catch((error) =>
        setState((current) => ({
          ...current,
          status: "error",
          error: error.message || "Unable to load receiving work.",
        })),
      );
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="Receiving"
        description="Material arriving for your department, and receipts waiting to be handed over or confirmed."
      />

      {state.status === "loading" && <LoadingState message="Loading receiving work…" />}
      {state.status === "error" && <ErrorState message={state.error} onRetry={load} />}

      {state.status === "ready" && (
        <>
          <section className={styles.section} aria-labelledby="pending-actions-title">
            <h2 id="pending-actions-title" className={styles.sectionTitle}>
              Waiting on you
            </h2>
            {state.pending.length === 0 ? (
              <EmptyState title="Nothing pending" message="No receipt is waiting for handover or confirmation." />
            ) : (
              <ul className={styles.list}>
                {state.pending.map((receipt) => (
                  <li key={receipt.id}>
                    <Link to={`/receiving/receipts/${receipt.id}`} className={styles.row}>
                      <div className={styles.identity}>
                        <strong>{receipt.dc_number}</strong>
                        <span>
                          {receipt.receipt_type === "ADMIN_FALLBACK"
                            ? `Temporary Site Administrator custody · ${receipt.received_by_name}`
                            : `Received by ${receipt.received_by_name}`}{" "}
                          · {formatDateTime(receipt.received_at)}
                        </span>
                      </div>
                      <div className={styles.badges}>
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

          <section className={styles.section} aria-labelledby="deliveries-title">
            <h2 id="deliveries-title" className={styles.sectionTitle}>
              Deliveries to receive
            </h2>
            {state.deliveries.length === 0 ? (
              <EmptyState
                title="No deliveries waiting"
                message="A Delivery Challan appears here once Procurement finalizes it."
              />
            ) : (
              <ul className={styles.list}>
                {state.deliveries.map((delivery) => (
                  <li key={delivery.id}>
                    <Link to={`/receiving/challans/${delivery.id}`} className={styles.row}>
                      <div className={styles.identity}>
                        <strong>{delivery.dc_number}</strong>
                        <span>
                          {delivery.department_name} · {delivery.ipo_number} ·{" "}
                          {delivery.line_count} {delivery.line_count === 1 ? "item" : "items"}
                        </span>
                      </div>
                      <StatusBadge
                        tone={DC_STATUS_TONE[delivery.status]}
                        label={delivery.status.replaceAll("_", " ")}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
