import { useState } from "react";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input } from "../../../shared/components/FormField.jsx";
import { formatPkr } from "../../procurement/utilities/money.js";
import styles from "./PurchasePanel.module.css";

// Each save records a purchase EVENT per line: the amount bought now, at the
// price paid now. One line is legitimately bought several times at different
// prices, and a single cumulative quantity could not represent that without
// destroying the earlier transaction.
//
// Safety against a lost response comes from the operation id, which is minted
// once per form attempt and reused by every retry of THAT attempt — so a
// retry books nothing new, while a genuinely later purchase gets a new one.
export function PurchasePanel({ lines, onSave, disabled, disabledReason }) {
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(lines.map((line) => [line.id, { quantity: "", actualUnitPrice: "", procurementNote: "" }])),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Minted per attempt, so the request stays identical across retries.
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());

  function update(lineId, field, value) {
    setDraft((current) => ({ ...current, [lineId]: { ...current[lineId], [field]: value } }));
  }

  async function handleSave() {
    if (saving) return;
    setSaving(true);
    setError(null);

    // Only lines the buyer actually filled in are submitted — an untouched
    // line is not a purchase of zero.
    const entries = lines
      .map((line) => ({ line, entry: draft[line.id] }))
      .filter(({ entry }) => String(entry.quantity || "").trim() !== "")
      .map(({ line, entry }) => ({
        ipoLineId: line.id,
        quantity: String(entry.quantity).trim(),
        actualUnitPrice: String(entry.actualUnitPrice || "").trim(),
        procurementNote: entry.procurementNote.trim() || null,
      }));

    if (entries.length === 0) {
      setError("Enter a purchased quantity and price for at least one line.");
      setSaving(false);
      return;
    }

    // This panel records purchases only. A correction is not a purchase at a
    // price of the buyer's choosing — it withdraws one specific earlier
    // purchase at that purchase's price — so it cannot be expressed here, and
    // the server would refuse it anyway.
    if (entries.some((entry) => Number(entry.quantity) <= 0)) {
      setError("A purchased quantity must be greater than zero.");
      setSaving(false);
      return;
    }

    try {
      await onSave({ operationId, lines: entries });
      // The purchase is committed; the next one is a new operation.
      setOperationId(crypto.randomUUID());
      setDraft(Object.fromEntries(lines.map((line) => [line.id, { quantity: "", actualUnitPrice: "", procurementNote: "" }])));
    } catch (saveError) {
      setError(saveError.message || "Unable to record purchasing.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="purchase-panel-title">
      <h2 id="purchase-panel-title" className={styles.title}>
        Record purchasing
      </h2>
      <p className={styles.hint}>
        Enter the quantity bought now and the price paid. Each save is recorded as its own purchase, so buying
        the rest later at a different price keeps both transactions. Estimated pricing is never overwritten, and
        purchasing more than the approved quantity is not permitted. To correct a mistake, a reversal is
        recorded against the specific purchase it withdraws, at that purchase&apos;s own price.
      </p>

      {disabled && <p className={styles.notice}>{disabledReason}</p>}

      <ul className={styles.lines}>
        {lines.map((line) => {
          const entry = draft[line.id];
          return (
            <li key={line.id} className={styles.line}>
              <div className={styles.lineHeading}>
                <strong>{line.item_name_snapshot}</strong>
                <span>
                  Approved {line.approved_quantity} {line.uom_name_snapshot} · already purchased{" "}
                  {line.purchased_quantity} · Estimated {formatPkr(line.estimated_unit_price)}
                </span>
              </div>
              <div className={styles.inputs}>
                <FormField label="Quantity bought now" htmlFor={`qty-${line.id}`}>
                  <Input
                    id={`qty-${line.id}`}
                    inputMode="decimal"
                    value={entry.quantity}
                    disabled={disabled}
                    onChange={(event) => update(line.id, "quantity", event.target.value)}
                  />
                </FormField>
                <FormField label="Price paid (Rs)" htmlFor={`price-${line.id}`}>
                  <Input
                    id={`price-${line.id}`}
                    inputMode="decimal"
                    value={entry.actualUnitPrice}
                    disabled={disabled || String(entry.quantity || "").trim() === ""}
                    onChange={(event) => update(line.id, "actualUnitPrice", event.target.value)}
                  />
                </FormField>
                <FormField label="Procurement note" htmlFor={`note-${line.id}`}>
                  <Input
                    id={`note-${line.id}`}
                    value={entry.procurementNote}
                    disabled={disabled}
                    onChange={(event) => update(line.id, "procurementNote", event.target.value)}
                  />
                </FormField>
              </div>
            </li>
          );
        })}
      </ul>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <Button onClick={handleSave} loading={saving} disabled={disabled}>
        Record purchase
      </Button>
    </section>
  );
}
