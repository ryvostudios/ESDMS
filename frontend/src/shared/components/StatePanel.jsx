import { Button } from "./Button.jsx";
import styles from "./StatePanel.module.css";

export function LoadingState({ message = "Loading…" }) {
  return (
    <div className={styles.panel} role="status" aria-live="polite">
      <span className={styles.spinner} aria-hidden="true" />
      <p className={styles.message}>{message}</p>
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", message, onRetry }) {
  return (
    <div className={styles.panel} role="alert">
      <span className={styles.icon} aria-hidden="true">
        !
      </span>
      <p className={styles.title}>{title}</p>
      {message && <p className={styles.message}>{message}</p>}
      {onRetry && (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function EmptyState({ title, message, action }) {
  return (
    <div className={styles.panel}>
      <p className={styles.title}>{title}</p>
      {message && <p className={styles.message}>{message}</p>}
      {action}
    </div>
  );
}
