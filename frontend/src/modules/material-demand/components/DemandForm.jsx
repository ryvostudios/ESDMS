import { useEffect, useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { listDepartmentsManage } from "../../workforce/api.js";
import { FormField, Textarea, Select } from "../../../shared/components/FormField.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { DemandItemPicker } from "./DemandItemPicker.jsx";
import { CarryForwardPanel } from "./CarryForwardPanel.jsx";
import styles from "./DemandForm.module.css";

function linesToSelections(lines) {
  const selections = {};
  for (const line of lines || []) {
    selections[line.catalog_entry_id] = String(line.requested_quantity);
  }
  return selections;
}

// A saved Draft line may already be a claim against an earlier unresolved
// requirement. Reopening the Draft has to restore that intent alongside the
// quantity, or a later save would serialize the line as an ordinary request —
// silently dropping the claim, leaving the source fully available, and letting
// the same outstanding quantity be carried into another Demand as well.
//
// Deliberately generic over source type: the server decides what a source is,
// so nothing here special-cases IPO shortfall, out-of-budget or receiving
// shortage.
function linesToCarryForward(lines) {
  const sources = {};
  for (const line of lines || []) {
    if (!line.carry_forward_source_type || !line.carry_forward_source_id) continue;

    sources[line.catalog_entry_id] = {
      sourceType: line.carry_forward_source_type,
      sourceId: line.carry_forward_source_id,
      quantity: Number(line.carry_forward_quantity),
    };
  }
  return sources;
}

// Reused for both "New Demand" (no initialDemand) and "Edit Draft"
// (initialDemand set) — mirrors GatePassForm's initialValues/onSubmit
// shape. Department is fixed once a Demand exists (see
// docs/DECISIONS.md — a line is ownership-pinned to its department via a
// composite FK); only a brand-new Demand from an all-departments actor
// gets to choose one.
export function DemandForm({ initialDemand, initialLines, submitLabel, onSubmit }) {
  const { user, hasPermission } = useAuth();
  const isDepartmentLocked = !hasPermission("demand.all_departments");
  const isEditing = Boolean(initialDemand);

  const [departmentId, setDepartmentId] = useState(
    initialDemand?.department_id || (isDepartmentLocked ? user.departmentId : ""),
  );
  const [departments, setDepartments] = useState([]);
  const [note, setNote] = useState(initialDemand?.note || "");
  const [selections, setSelections] = useState(() => linesToSelections(initialLines));
  // Which selected lines are claims against an earlier unresolved requirement,
  // keyed by catalogue entry. Seeded from the Draft being edited so the claim
  // survives reopen/edit/save, and sent with the line so the server can make
  // it authoritative at submit. The server re-validates the source and its
  // remaining availability regardless — this state is intent, never authority.
  const [carryForward, setCarryForward] = useState(() => linesToCarryForward(initialLines));
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isDepartmentLocked || isEditing) return;
    listDepartmentsManage()
      .then((response) => setDepartments(response.data))
      .catch(() => {});
  }, [isDepartmentLocked, isEditing]);

  // Removing a line from the Draft withdraws its claim with it: a material the
  // user later re-adds by hand is a fresh requirement, not a continuation of
  // the old carried one. Without this, an unchecked-then-re-checked item would
  // silently keep pointing at a source the user never chose for it.
  function handleSelectionsChange(next) {
    setSelections(next);
    setCarryForward((current) => {
      const retained = {};
      for (const [catalogEntryId, source] of Object.entries(current)) {
        if (catalogEntryId in next) retained[catalogEntryId] = source;
      }
      return retained;
    });
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const lines = Object.entries(selections)
      .filter(([, quantity]) => quantity !== "" && Number(quantity) > 0)
      .map(([catalogEntryId, quantity]) => {
        const source = carryForward[catalogEntryId];
        return {
          catalogEntryId,
          quantity: Number(quantity),
          // Never claim more than this line actually asks for.
          ...(source
            ? {
                carryForward: {
                  ...source,
                  quantity: Math.min(Number(source.quantity), Number(quantity)),
                },
              }
            : {}),
        };
      });

    setFormError(null);
    setSubmitting(true);

    try {
      await onSubmit({
        ...(!isEditing && { departmentId }),
        note: note.trim() || null,
        lines,
      });
    } catch (error) {
      setFormError(error.message || "Unable to save this Demand. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate>
      {formError && (
        <p className={styles.formError} role="alert">
          {formError}
        </p>
      )}

      {!isEditing && !isDepartmentLocked && (
        <FormField label="Department" htmlFor="departmentId" required>
          <Select
            id="departmentId"
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
            disabled={submitting}
          >
            <option value="">Select department</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
                {department.site_name ? ` — ${department.site_name}` : ""}
              </option>
            ))}
          </Select>
        </FormField>
      )}

      <FormField label="Note / Justification" htmlFor="note" hint="Optional">
        <Textarea id="note" value={note} onChange={(event) => setNote(event.target.value)} disabled={submitting} />
      </FormField>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Materials</h2>
        {/* Unresolved prior requirements for the items already chosen. Shown
          only while creating; an existing Draft is edited line by line. */}
      {!isEditing && (
        <CarryForwardPanel
          departmentId={departmentId}
          selections={selections}
          onAdd={(catalogEntryId, quantity, source) => {
            setSelections((current) => ({ ...current, [catalogEntryId]: String(quantity) }));
            setCarryForward((current) => ({ ...current, [catalogEntryId]: source }));
          }}
        />
      )}

      <DemandItemPicker
          departmentId={departmentId}
          selections={selections}
          onChange={handleSelectionsChange}
          disabled={submitting}
        />
      </div>

      <div className={styles.formActions}>
        <Button type="submit" loading={submitting} disabled={!departmentId}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
