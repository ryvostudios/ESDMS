import { useState } from "react";
import { Dialog } from "../../../shared/components/Dialog.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Textarea } from "../../../shared/components/FormField.jsx";
import styles from "./PurchasePanel.module.css";

// Only purchased, not-yet-delivered quantity can go on a challan. The server
// re-checks the same rule under a lock, so this is convenience, not the
// boundary.
export function CreateChallanDialog({ open, onClose, lines, onCreate }) {
  const [quantities, setQuantities] = useState({});
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // Stable per shipment, so a retry after a lost response reuses the challan
  // that already exists instead of cutting a second one.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  const deliverable = lines.filter(
    (line) => Number(line.purchased_quantity) - Number(line.allocated_quantity) > 0,
  );

  function handleClose() {
    setQuantities({});
    setNote("");
    setError(null);
    setOperationId(crypto.randomUUID());
    onClose();
  }

  async function handleCreate() {
    if (submitting) return;

    const selected = deliverable
      .map((line) => ({ ipoLineId: line.id, quantity: String(quantities[line.id] || "").trim() }))
      .filter((line) => line.quantity && Number(line.quantity) > 0);

    if (selected.length === 0) {
      setError("Select at least one line and quantity to deliver.");
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      await onCreate({ operationId, lines: selected, note: note.trim() || null });
      handleClose();
    } catch (createError) {
      setError(createError.message || "Unable to create the Delivery Challan.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} title="New Delivery Challan" labelledBy="create-challan-title">
      {deliverable.length === 0 ? (
        <p className={styles.hint}>
          Nothing is available to deliver yet. Record purchasing first, or every purchased quantity is already on
          a challan.
        </p>
      ) : (
        <ul className={styles.lines}>
          {deliverable.map((line) => {
            const remaining = Number(line.purchased_quantity) - Number(line.allocated_quantity);
            return (
              <li key={line.id} className={styles.line}>
                <div className={styles.lineHeading}>
                  <strong>{line.item_name_snapshot}</strong>
                  <span>
                    Available to deliver: {remaining.toFixed(2)} {line.uom_name_snapshot}
                  </span>
                </div>
                <FormField label="Quantity on this challan" htmlFor={`dc-qty-${line.id}`}>
                  <Input
                    id={`dc-qty-${line.id}`}
                    inputMode="decimal"
                    value={quantities[line.id] || ""}
                    onChange={(event) =>
                      setQuantities((current) => ({ ...current, [line.id]: event.target.value }))
                    }
                  />
                </FormField>
              </li>
            );
          })}
        </ul>
      )}

      <FormField label="Note (optional)" htmlFor="dc-note">
        <Textarea id="dc-note" rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </FormField>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div className={styles.dialogActions}>
        <Button variant="secondary" onClick={handleClose}>
          Cancel
        </Button>
        <Button onClick={handleCreate} loading={submitting} disabled={deliverable.length === 0}>
          Create draft challan
        </Button>
      </div>
    </Dialog>
  );
}
