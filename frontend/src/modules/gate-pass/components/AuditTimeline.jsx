import { formatEnumLabel } from "../../../shared/utilities/format.js";
import styles from "./AuditTimeline.module.css";

const ACTION_LABEL = {
  CREATE: "Created",
  EDIT_DRAFT: "Draft edited",
  SUBMIT: "Submitted for approval",
  APPROVE: "Approved",
  REJECT: "Rejected",
  CANCEL: "Cancelled",
  EXIT: "Vehicle exited",
  RETURN: "Vehicle returned",
};

export function AuditTimeline({ entries }) {
  return (
    <ol className={styles.timeline}>
      {entries.map((entry) => (
        <li className={styles.entry} key={entry.id}>
          <div className={styles.markerColumn}>
            <span className={styles.marker} aria-hidden="true" />
            <span className={styles.line} aria-hidden="true" />
          </div>
          <div className={styles.content}>
            <p className={styles.action}>{ACTION_LABEL[entry.action] || formatEnumLabel(entry.action)}</p>
            <p className={styles.meta}>
              {entry.actorName} · {new Date(entry.createdAt).toLocaleString()}
            </p>
            {entry.metadata?.reason && <p className={styles.reason}>“{entry.metadata.reason}”</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
