import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import styles from "./AuditTimeline.module.css";

const ACTION_LABEL = {
  CREATE: "Created",
  EDIT_DRAFT: "Draft edited",
  SUBMIT: "Submitted for review",
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
              {entry.actorName} · {formatDateTime(entry.createdAt)}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
