import { useEffect, useRef } from "react";
import styles from "./Dialog.module.css";

export function Dialog({ open, onClose, title, children, labelledBy }) {
  const dialogRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    dialogRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) {
    return null;
  }

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div
        ref={dialogRef}
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id={labelledBy} className={styles.title}>
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
