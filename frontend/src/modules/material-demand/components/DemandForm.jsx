import { useEffect, useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { listDepartmentsManage } from "../../workforce/api.js";
import { FormField, Textarea, Select } from "../../../shared/components/FormField.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { DemandItemPicker } from "./DemandItemPicker.jsx";
import styles from "./DemandForm.module.css";

function linesToSelections(lines) {
  const selections = {};
  for (const line of lines || []) {
    selections[line.catalog_entry_id] = String(line.requested_quantity);
  }
  return selections;
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
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (isDepartmentLocked || isEditing) return;
    listDepartmentsManage()
      .then((response) => setDepartments(response.data))
      .catch(() => {});
  }, [isDepartmentLocked, isEditing]);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const lines = Object.entries(selections)
      .filter(([, quantity]) => quantity !== "" && Number(quantity) > 0)
      .map(([catalogEntryId, quantity]) => ({ catalogEntryId, quantity: Number(quantity) }));

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
        <DemandItemPicker
          departmentId={departmentId}
          selections={selections}
          onChange={setSelections}
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
