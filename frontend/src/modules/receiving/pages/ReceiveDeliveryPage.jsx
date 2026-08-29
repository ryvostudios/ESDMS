import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { FormField, Input, Select, Textarea } from "../../../shared/components/FormField.jsx";
import { LoadingState } from "../../../shared/components/StatePanel.jsx";
import { RecordErrorState } from "../../../shared/components/RecordErrorState.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { downloadBlob } from "../../../shared/utilities/download.js";
import { getDeliveryChallanPdf } from "../../delivery-challan/api.js";
import { getDeliveryForReceiving, recordReceipt } from "../api.js";
import { RECEIPT_STATUS_LABEL, RECEIPT_STATUS_TONE } from "../../ipo/constants.js";
import styles from "./ReceiveDeliveryPage.module.css";

const DISCREPANCY_TYPES = [
  ["SHORT", "Short quantity"],
  ["DAMAGED", "Damaged"],
  ["WRONG_SPEC", "Wrong specification"],
  ["REJECTED", "Rejected"],
];

export function ReceiveDeliveryPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canReceive = hasPermission("receiving.receive");
  const canFallback = hasPermission("receiving.fallback_receive");
  const fallbackOnly = canFallback && !canReceive;
  const [state, setState] = useState({ result: null, status: "loading", error: null });
  const [draft, setDraft] = useState({});
  const [note, setNote] = useState("");
  const [fallback, setFallback] = useState(fallbackOnly);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(null);
  // Minted once per receipt attempt. Retrying after a lost response — common
  // on a phone at a site gate — reuses it, so the same physical delivery can
  // never be booked twice.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return getDeliveryForReceiving(id)
      .then((response) => {
        setState({ result: response.data, status: "ready", error: null });
        setOperationId(crypto.randomUUID());
        setDraft(
          Object.fromEntries(
            response.data.lines.map((line) => [
              line.id,
              { receivedQuantity: "", discrepancyQuantity: "", discrepancyType: "", discrepancyNote: "" },
            ]),
          ),
        );
      })
      .catch((error) =>
        setState({ result: null, status: "error", error }),
      );
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (state.status === "loading") return <LoadingState message="Loading delivery…" />;
  if (state.status === "error")
    return <RecordErrorState error={state.error} onRetry={load} fallback="Unable to load this delivery." />;

  const { deliveryChallan: challan, lines, receipts } = state.result;
  const openLines = lines.filter((line) => Number(line.unresolved_quantity) > 0);

  function update(lineId, field, value) {
    setDraft((current) => ({ ...current, [lineId]: { ...current[lineId], [field]: value } }));
  }

  async function handleSubmit() {
    if (submitting) return;

    const payloadLines = openLines
      .map((line) => {
        const entry = draft[line.id];
        const received = String(entry.receivedQuantity || "").trim();
        const discrepancy = String(entry.discrepancyQuantity || "").trim();
        if (!received && !discrepancy) return null;
        return {
          dcLineId: line.id,
          receivedQuantity: received || "0",
          discrepancyQuantity: discrepancy || "0",
          discrepancyType: Number(discrepancy || 0) > 0 ? entry.discrepancyType || null : null,
          discrepancyNote: entry.discrepancyNote.trim() || null,
        };
      })
      .filter(Boolean);

    if (payloadLines.length === 0) {
      setSubmitError("Record a received or discrepancy quantity for at least one item.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      const response = await recordReceipt(id, {
        operationId,
        fallback: fallbackOnly || fallback,
        note: note.trim() || null,
        lines: payloadLines,
      });
      navigate(`/receiving/receipts/${response.data.receipt.id}`);
    } catch (error) {
      // The operation id is deliberately NOT regenerated here: if this failure
      // was a lost response rather than a rejection, pressing the button again
      // must be recognised as the same receipt.
      setSubmitError(error.message || "Unable to record this receipt.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={challan.dc_number}
        description={`${challan.department_name} · ${challan.ipo_number} · Demand ${challan.demand_number}`}
        actions={
          <Button
            variant="secondary"
            onClick={async () => {
              await downloadBlob(
                await getDeliveryChallanPdf(challan.id),
                `${challan.dc_number.replaceAll("/", "-")}.pdf`,
              );
            }}
          >
            Download Challan
          </Button>
        }
      />

      {receipts.length > 0 && (
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Already recorded</h2>
          <ul className={styles.receipts}>
            {receipts.map((receipt) => (
              <li key={receipt.id}>
                <Link to={`/receiving/receipts/${receipt.id}`}>
                  <span>
                    {receipt.receipt_type === "ADMIN_FALLBACK" ? "Site Administrator custody" : "Received"} by{" "}
                    {receipt.received_by_name} · {formatDateTime(receipt.received_at)}
                  </span>
                  <StatusBadge
                    tone={RECEIPT_STATUS_TONE[receipt.status]}
                    label={RECEIPT_STATUS_LABEL[receipt.status]}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {openLines.length === 0 ? (
        <section className={styles.section}>
          <p className={styles.done}>
            Every item on this challan has been fully accounted for. Nothing further to receive.
          </p>
        </section>
      ) : (
        <section className={styles.section} aria-labelledby="record-receipt-title">
          <h2 id="record-receipt-title" className={styles.sectionTitle}>
            Record receipt
          </h2>
          <p className={styles.hint}>
            Enter what physically arrived. Anything missing, damaged or rejected is recorded separately — it is
            never counted as received. This records arrival only; it does not create stock.
          </p>

          {fallbackOnly && (
            <p className={styles.fallback} role="note" data-testid="fallback-notice">
              <strong>Temporary Site Administrator custody.</strong> You are receiving as temporary custody because nobody from the department is available. This is not a department receipt; the department must acknowledge the handover afterwards.
            </p>
          )}

          {canFallback && !fallbackOnly && (
            <label className={styles.fallback}>
              <input
                type="checkbox"
                checked={fallback}
                onChange={(event) => setFallback(event.target.checked)}
              />
              <span>
                Receive as temporary Site Administrator custody — nobody from the department is available. The department
                will be asked to acknowledge the handover afterwards.
              </span>
            </label>
          )}

          <ul className={styles.lines}>
            {openLines.map((line) => {
              const entry = draft[line.id] || {};
              return (
                <li key={line.id} className={styles.line}>
                  <div className={styles.lineHeading}>
                    <strong>{line.item_name_snapshot}</strong>
                    <span>
                      Outstanding on this challan: {line.unresolved_quantity} {line.uom_name_snapshot} (challan
                      quantity {line.quantity})
                    </span>
                  </div>
                  <div className={styles.inputs}>
                    <FormField label="Received" htmlFor={`recv-${line.id}`}>
                      <Input
                        id={`recv-${line.id}`}
                        inputMode="decimal"
                        value={entry.receivedQuantity || ""}
                        onChange={(event) => update(line.id, "receivedQuantity", event.target.value)}
                      />
                    </FormField>
                    <FormField label="Missing / damaged" htmlFor={`disc-${line.id}`}>
                      <Input
                        id={`disc-${line.id}`}
                        inputMode="decimal"
                        value={entry.discrepancyQuantity || ""}
                        onChange={(event) => update(line.id, "discrepancyQuantity", event.target.value)}
                      />
                    </FormField>
                    <FormField label="Discrepancy type" htmlFor={`disctype-${line.id}`}>
                      <Select
                        id={`disctype-${line.id}`}
                        value={entry.discrepancyType || ""}
                        disabled={Number(entry.discrepancyQuantity || 0) === 0}
                        onChange={(event) => update(line.id, "discrepancyType", event.target.value)}
                      >
                        <option value="">Select…</option>
                        {DISCREPANCY_TYPES.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    </FormField>
                    <FormField label="Discrepancy note" htmlFor={`discnote-${line.id}`}>
                      <Input
                        id={`discnote-${line.id}`}
                        value={entry.discrepancyNote || ""}
                        disabled={Number(entry.discrepancyQuantity || 0) === 0}
                        onChange={(event) => update(line.id, "discrepancyNote", event.target.value)}
                      />
                    </FormField>
                  </div>
                </li>
              );
            })}
          </ul>

          <FormField label="Note (optional)" htmlFor="receipt-note">
            <Textarea id="receipt-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
          </FormField>

          {submitError && (
            <p className={styles.error} role="alert">
              {submitError}
            </p>
          )}

          <Button onClick={handleSubmit} loading={submitting} disabled={!canReceive && !canFallback}>
            {fallbackOnly || fallback ? "Receive into Temporary Site Administrator Custody" : "Record receipt"}
          </Button>
        </section>
      )}
    </div>
  );
}
