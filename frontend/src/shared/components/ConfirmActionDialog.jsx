import { useState } from "react";
import { Dialog } from "./Dialog.jsx";
import { Button } from "./Button.jsx";
import styles from "./Dialog.module.css";

export function ConfirmActionDialog({ open, onClose, title, message, confirmLabel, variant = "primary", onConfirm }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  async function handleConfirm() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    try {
      await onConfirm();
      onClose();
    } catch (submitError) {
      setError(submitError.message || "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={title} labelledBy="confirm-action-title">
      <p className={styles.message}>{message}</p>
      {error && (
        <p className={styles.errorMessage} role="alert">
          {error}
        </p>
      )}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button variant={variant} onClick={handleConfirm} loading={submitting}>
          {confirmLabel}
        </Button>
      </div>
    </Dialog>
  );
}
