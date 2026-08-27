import { useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { setLineDispositions } from "../../material-demand/api.js";
import { formatPkr } from "../utilities/money.js";
import { PriceComparison } from "./PriceComparison.jsx";
import styles from "./LineDispositionPanel.module.css";

const EXCLUSION_CATEGORIES = [
  ["OUT_OF_BUDGET", "Out of budget"],
  ["NOT_REQUIRED_NOW", "Not required now"],
  ["ALREADY_AVAILABLE", "Already available"],
  ["DUPLICATE", "Duplicate"],
  ["OTHER", "Other"],
];

// Management's line-by-line purchasing decision, taken BEFORE the final
// review/approval is recorded. Excluding a line never deletes it: the Demand
// line, its quantity and its estimate survive, and the department can carry
// it forward into a later Demand.
export function LineDispositionPanel({ detail, onChanged }) {
  const { hasPermission } = useAuth();
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(
      detail.lines.map((line) => [
        line.demand_line_id,
        {
          disposition: line.disposition || "APPROVED_FOR_PURCHASE",
          exclusionCategory: line.exclusion_category || "",
          reason: line.exclusion_reason || "",
        },
      ]),
    ),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const decided = (detail.finalApprovals || []).length > 0;
  const editable =
    detail.demand.status === "PENDING_FINAL_APPROVAL" &&
    !decided &&
    hasPermission("procurement.view_prices") &&
    (hasPermission("demand.review") || hasPermission("demand.approve"));

  function update(lineId, field, value) {
    setDraft((current) => ({ ...current, [lineId]: { ...current[lineId], [field]: value } }));
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      await setLineDispositions(detail.demand.id, {
        pricingId: detail.pricing.id,
        lines: detail.lines.map((line) => {
          const entry = draft[line.demand_line_id];
          const excluded = entry.disposition === "EXCLUDED";
          return {
            demandLineId: line.demand_line_id,
            disposition: entry.disposition,
            exclusionCategory: excluded ? entry.exclusionCategory || null : null,
            reason: excluded ? entry.reason.trim() || null : null,
          };
        }),
      });
      await onChanged();
    } catch (saveError) {
      setError(saveError.message || "Unable to record line purchasing decisions.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="disposition-title">
      <h2 id="disposition-title" className={styles.title}>
        Line purchasing decisions
      </h2>
      <p className={styles.hint}>
        Compare each estimate against the last actual purchase price, and decide line by line what goes into the
        IPO. An excluded line is kept in full — it is never deleted — and stays available for a later Demand.
        {decided && " These decisions are frozen because a final decision has already been recorded."}
      </p>

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Qty</th>
              <th scope="col">New estimate</th>
              <th scope="col">Vs previous actual</th>
              <th scope="col">Line total</th>
              <th scope="col">Decision</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => {
              const entry = draft[line.demand_line_id];
              const excluded = entry.disposition === "EXCLUDED";
              return (
                <tr key={line.demand_line_id}>
                  <td>{line.item_name_snapshot}</td>
                  <td>
                    {line.requested_quantity} {line.uom_code_snapshot}
                  </td>
                  <td>{formatPkr(line.estimated_unit_price)}</td>
                  <td>
                    <PriceComparison line={line} />
                  </td>
                  <td>{formatPkr(line.line_total)}</td>
                  <td className={styles.decisionCell}>
                    {editable ? (
                      <>
                        <FormField label="Decision" htmlFor={`disp-${line.demand_line_id}`}>
                          <Select
                            id={`disp-${line.demand_line_id}`}
                            value={entry.disposition}
                            onChange={(event) =>
                              update(line.demand_line_id, "disposition", event.target.value)
                            }
                          >
                            <option value="APPROVED_FOR_PURCHASE">Approve for purchase</option>
                            <option value="EXCLUDED">Exclude</option>
                          </Select>
                        </FormField>
                        {excluded && (
                          <>
                            <FormField label="Reason" htmlFor={`cat-${line.demand_line_id}`}>
                              <Select
                                id={`cat-${line.demand_line_id}`}
                                value={entry.exclusionCategory}
                                onChange={(event) =>
                                  update(line.demand_line_id, "exclusionCategory", event.target.value)
                                }
                              >
                                <option value="">Select…</option>
                                {EXCLUSION_CATEGORIES.map(([value, label]) => (
                                  <option key={value} value={value}>
                                    {label}
                                  </option>
                                ))}
                              </Select>
                            </FormField>
                            <FormField label="Explanation" htmlFor={`reason-${line.demand_line_id}`}>
                              <Input
                                id={`reason-${line.demand_line_id}`}
                                value={entry.reason}
                                onChange={(event) => update(line.demand_line_id, "reason", event.target.value)}
                              />
                            </FormField>
                          </>
                        )}
                      </>
                    ) : (
                      <StatusBadge
                        tone={line.disposition === "EXCLUDED" ? "danger" : "success"}
                        label={
                          line.disposition === "EXCLUDED"
                            ? `Excluded — ${(line.exclusion_category || "").replaceAll("_", " ").toLowerCase()}`
                            : "Approved for purchase"
                        }
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {editable && (
        <Button onClick={save} loading={saving}>
          Save line decisions
        </Button>
      )}
    </section>
  );
}
