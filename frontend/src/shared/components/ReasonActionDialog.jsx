import { useState } from "react";
import { Dialog } from "./Dialog.jsx";
import { Button } from "./Button.jsx";
import { FormField, Textarea } from "./FormField.jsx";
import styles from "./Dialog.module.css";

export function ReasonActionDialog({ open, onClose, title, message, confirmLabel, onConfirm }) {
  const [reason, setReason] = useState("");
  const [fieldError, setFieldError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  function handleClose() {
    setReason("");
    setFieldError(null);
    setSubmitError(null);
    onClose();
  }

  async function handleConfirm() {
    if (submitting) return;

    if (!reason.trim()) {
      setFieldError("A reason is required.");
      return;
    }

    setSubmitting(true);
    setSubmitError(null);

    try {
      await onConfirm(reason.trim());
      handleClose();
    } catch (error) {
      setSubmitError(error.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={handleClose} title={title} labelledBy="reason-action-title">
      <p className={styles.message}>{message}</p>
      <FormField label="Reason" htmlFor="action-reason" required error={fieldError}>
        <Textarea
          id="action-reason"
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (fieldError) setFieldError(null);
          }}
          disabled={submitting}
          rows={3}
        />
      </FormField>
      {submitError && (
        <p className={styles.errorMessage} role="alert">
          {submitError}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button variant="danger" onClick={handleConfirm} loading={submitting}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
