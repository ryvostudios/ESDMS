import styles from "./PricingSummary.module.css";
import { formatPkr } from "../utilities/money.js";

export function PricingSummary({ detail }) {
  return (
    <div className={styles.panel}>
      <div className={styles.heading}>
        <div>
          <h2>Pricing</h2>
          <p>Estimated market pricing · {detail.pricing.currency}</p>
        </div>
        <span className={styles.status}>{detail.pricing.status}</span>
      </div>

      <p className={styles.historyNote}>No previous purchase price is available yet.</p>
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
      <p className={styles.pending}>Pending Final Management Review / Formal Approval</p>
    </div>
  );
}
