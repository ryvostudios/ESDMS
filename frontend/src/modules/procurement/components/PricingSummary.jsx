import styles from "./PricingSummary.module.css";
import { formatPkr } from "../utilities/money.js";
import { formatDateTime } from "../../../shared/utilities/datetime.js";

export function PricingSummary({ detail }) {
  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <div>
          <h2>Pricing</h2>
          <p>
            Estimated market pricing · {detail.pricing.currency} · Demand revision {detail.demand.revision} · Pricing
            version {detail.pricing.version}
          </p>
        </div>
        <span className={styles.status}>{detail.pricing.status}</span>
      </div>

      <p className={styles.historyNote}>No previous purchase price is available yet.</p>
      {detail.pricing.submitted_at && (
        <p className={styles.historyNote}>Submitted {formatDateTime(detail.pricing.submitted_at)}</p>
      )}
      <ul className={styles.lines}>
        {detail.lines.map((line) => (
          <li key={line.demand_line_id}>
            <div>
              <strong>{line.item_name_snapshot}</strong>
              <span>
                {line.requested_quantity} {line.uom_name_snapshot} × {formatPkr(line.estimated_unit_price)}
              </span>
              {line.procurement_note && <span>Procurement note: {line.procurement_note}</span>}
            </div>
            <strong>{formatPkr(line.line_total)}</strong>
          </li>
        ))}
      </ul>
      <div className={styles.total}>
        <span>Estimated Total</span>
        <strong>{formatPkr(detail.estimatedTotal)}</strong>
      </div>
      {detail.demand.status === "PENDING_FINAL_APPROVAL" && (
        <p className={styles.pending}>Pending Final Management Review / Formal Approval</p>
      )}
      {detail.demand.status === "PRICING_REVISION_REQUIRED" && (
        <p className={styles.pending}>Pricing Revision Required</p>
      )}
      {detail.demand.status === "READY_FOR_IPO" && <p className={styles.pending}>Ready for IPO</p>}
    </div>
  );
}
