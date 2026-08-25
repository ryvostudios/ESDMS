import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import styles from "./AuditTimeline.module.css";

const ACTION_LABEL = {
  CREATE: "Created",
  EDIT_DRAFT: "Draft edited",
  SUBMIT: "Submitted for review",
  MANAGEMENT_REVIEW_APPROVED: "Management Review approved",
  MANAGEMENT_REVIEW_REJECTED: "Management Review rejected",
  FORMAL_APPROVAL_APPROVED: "Formal Approval approved",
  FORMAL_APPROVAL_REJECTED: "Formal Approval rejected",
  READY_FOR_PRICING: "Ready for pricing",
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
              {entry.actor_name} · {formatDateTime(entry.created_at)}
            </p>
            {entry.metadata?.reason && <p className={styles.reason}>“{entry.metadata.reason}”</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
