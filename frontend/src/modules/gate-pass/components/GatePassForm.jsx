import { useState } from "react";
import { useDepartments } from "../hooks/useDepartments.js";
import { GATE_PASS_PURPOSES } from "../constants.js";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { FormField, Input, Textarea, Select } from "../../../shared/components/FormField.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { PlusIcon, TrashIcon } from "../../../shared/icons.jsx";
import styles from "./GatePassForm.module.css";

const EMPTY_ITEM = { description: "", partNumber: "", quantity: "1", unit: "" };

function defaultValues() {
  return {
    issuingDepartmentId: "",
    requestedBy: "",
    destination: "",
    driverName: "",
    driverPhone: "",
    vehicleRegistration: "",
    jobOrderId: "",
    purpose: "",
    expectedReturnDate: "",
    remarks: "",
  };
}

function validate(values, items) {
  const fieldErrors = {};

  if (!values.issuingDepartmentId) fieldErrors.issuingDepartmentId = "Department is required.";
  if (!values.requestedBy.trim()) fieldErrors.requestedBy = "Requested by is required.";
  if (!values.destination.trim()) fieldErrors.destination = "Destination is required.";
  if (!values.driverName.trim()) fieldErrors.driverName = "Driver name is required.";
  if (!values.driverPhone.trim() || values.driverPhone.trim().length < 5) {
    fieldErrors.driverPhone = "A valid driver phone number is required.";
  }
  if (!values.vehicleRegistration.trim()) fieldErrors.vehicleRegistration = "Vehicle registration is required.";
  if (!values.purpose) fieldErrors.purpose = "Purpose is required.";

  const itemErrors = items.map((item) => {
    const rowErrors = {};
    if (!item.description.trim()) rowErrors.description = "Required.";
    if (!item.quantity || Number(item.quantity) <= 0) rowErrors.quantity = "Must be > 0.";
    return rowErrors;
  });

  const hasItemErrors = itemErrors.some((row) => Object.keys(row).length > 0);

  return { fieldErrors, itemErrors, hasErrors: Object.keys(fieldErrors).length > 0 || hasItemErrors };
}

export function GatePassForm({ initialValues, initialItems, submitLabel, onSubmit }) {
  const { departments, status: departmentsStatus } = useDepartments();
  const [values, setValues] = useState(() => ({ ...defaultValues(), ...initialValues }));
  const [items, setItems] = useState(() => initialItems?.length ? initialItems : [{ ...EMPTY_ITEM }]);
  const [fieldErrors, setFieldErrors] = useState({});
  const [itemErrors, setItemErrors] = useState([]);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function updateField(name, value) {
    setValues((prev) => ({ ...prev, [name]: value }));
  }

  function updateItem(index, name, value) {
    setItems((prev) => prev.map((item, itemIndex) => (itemIndex === index ? { ...item, [name]: value } : item)));
  }

  function addItem() {
    setItems((prev) => [...prev, { ...EMPTY_ITEM }]);
  }

  function removeItem(index) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, itemIndex) => itemIndex !== index) : prev));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const validation = validate(values, items);
    setFieldErrors(validation.fieldErrors);
    setItemErrors(validation.itemErrors);
    setFormError(null);

    if (validation.hasErrors) {
      return;
    }

    setSubmitting(true);

    try {
      await onSubmit({
        ...values,
        jobOrderId: values.jobOrderId.trim() || null,
        expectedReturnDate: values.expectedReturnDate || null,
        remarks: values.remarks.trim() || null,
        items: items.map((item) => ({
          description: item.description.trim(),
          partNumber: item.partNumber.trim() || null,
          quantity: Number(item.quantity),
          unit: item.unit.trim() || null,
        })),
      });
    } catch (error) {
      setFormError(error.message || "Unable to save this Gate Pass. Please try again.");
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

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Gate pass details</h2>
        <div className={styles.grid}>
          <FormField label="Issuing Department" htmlFor="issuingDepartmentId" required error={fieldErrors.issuingDepartmentId}>
            <Select
              id="issuingDepartmentId"
              value={values.issuingDepartmentId}
              onChange={(event) => updateField("issuingDepartmentId", event.target.value)}
              error={fieldErrors.issuingDepartmentId}
              disabled={submitting || departmentsStatus === "loading"}
            >
              <option value="">Select department</option>
              {departments.map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Requested By" htmlFor="requestedBy" required error={fieldErrors.requestedBy} hint="The person requesting this pass">
            <Input
              id="requestedBy"
              value={values.requestedBy}
              onChange={(event) => updateField("requestedBy", event.target.value)}
              error={fieldErrors.requestedBy}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Issued To / Destination" htmlFor="destination" required error={fieldErrors.destination}>
            <Input
              id="destination"
              value={values.destination}
              onChange={(event) => updateField("destination", event.target.value)}
              error={fieldErrors.destination}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Purpose" htmlFor="purpose" required error={fieldErrors.purpose}>
            <Select
              id="purpose"
              value={values.purpose}
              onChange={(event) => updateField("purpose", event.target.value)}
              error={fieldErrors.purpose}
              disabled={submitting}
            >
              <option value="">Select purpose</option>
              {GATE_PASS_PURPOSES.map((purpose) => (
                <option key={purpose} value={purpose}>
                  {formatEnumLabel(purpose)}
                </option>
              ))}
            </Select>
          </FormField>

          <FormField label="Driver Name" htmlFor="driverName" required error={fieldErrors.driverName}>
            <Input
              id="driverName"
              value={values.driverName}
              onChange={(event) => updateField("driverName", event.target.value)}
              error={fieldErrors.driverName}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Driver Phone" htmlFor="driverPhone" required error={fieldErrors.driverPhone} hint="Used to send the approved pass via WhatsApp">
            <Input
              id="driverPhone"
              type="tel"
              value={values.driverPhone}
              onChange={(event) => updateField("driverPhone", event.target.value)}
              error={fieldErrors.driverPhone}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Vehicle Registration" htmlFor="vehicleRegistration" required error={fieldErrors.vehicleRegistration}>
            <Input
              id="vehicleRegistration"
              value={values.vehicleRegistration}
              onChange={(event) => updateField("vehicleRegistration", event.target.value.toUpperCase())}
              error={fieldErrors.vehicleRegistration}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Job Order ID" htmlFor="jobOrderId" hint="Optional">
            <Input
              id="jobOrderId"
              value={values.jobOrderId}
              onChange={(event) => updateField("jobOrderId", event.target.value)}
              disabled={submitting}
            />
          </FormField>

          <FormField label="Expected Return Date" htmlFor="expectedReturnDate" hint="Optional">
            <Input
              id="expectedReturnDate"
              type="date"
              value={values.expectedReturnDate}
              onChange={(event) => updateField("expectedReturnDate", event.target.value)}
              disabled={submitting}
            />
          </FormField>

          <div className={styles.fullRow}>
            <FormField label="Remarks" htmlFor="remarks" hint="Optional">
              <Textarea
                id="remarks"
                value={values.remarks}
                onChange={(event) => updateField("remarks", event.target.value)}
                disabled={submitting}
              />
            </FormField>
          </div>
        </div>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>Items</h2>

        {items.map((item, index) => (
          <div className={styles.itemRow} key={index}>
            <FormField label="Description" htmlFor={`item-description-${index}`} required error={itemErrors[index]?.description}>
              <Input
                id={`item-description-${index}`}
                value={item.description}
                onChange={(event) => updateItem(index, "description", event.target.value)}
                error={itemErrors[index]?.description}
                disabled={submitting}
              />
            </FormField>
            <FormField label="Part Number" htmlFor={`item-part-${index}`}>
              <Input
                id={`item-part-${index}`}
                value={item.partNumber}
                onChange={(event) => updateItem(index, "partNumber", event.target.value)}
                disabled={submitting}
              />
            </FormField>
            <FormField label="Quantity" htmlFor={`item-quantity-${index}`} required error={itemErrors[index]?.quantity}>
              <Input
                id={`item-quantity-${index}`}
                type="number"
                min="0"
                step="any"
                value={item.quantity}
                onChange={(event) => updateItem(index, "quantity", event.target.value)}
                error={itemErrors[index]?.quantity}
                disabled={submitting}
              />
            </FormField>
            <FormField label="Unit" htmlFor={`item-unit-${index}`}>
              <Input
                id={`item-unit-${index}`}
                value={item.unit}
                onChange={(event) => updateItem(index, "unit", event.target.value)}
                disabled={submitting}
              />
            </FormField>
            <Button
              type="button"
              variant="ghost"
              className={styles.removeButton}
              onClick={() => removeItem(index)}
              disabled={submitting || items.length === 1}
              aria-label="Remove item"
            >
              <TrashIcon width={16} height={16} />
            </Button>
          </div>
        ))}

        <Button type="button" variant="secondary" onClick={addItem} disabled={submitting}>
          <PlusIcon width={16} height={16} />
          Add item
        </Button>
      </div>

      <div className={styles.formActions}>
        <Button type="submit" loading={submitting}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
