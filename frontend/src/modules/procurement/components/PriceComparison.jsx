import { formatPkr } from "../utilities/money.js";
import styles from "./PriceComparison.module.css";

// Change is conveyed by an explicit sign and words, never by colour alone —
// a red/green-only indicator is unreadable for a colour-blind buyer and
// invisible to a screen reader.
const DIRECTION_LABEL = {
  INCREASE: "increase",
  DECREASE: "decrease",
  SAME: "no change",
};

const DIRECTION_CLASS = {
  INCREASE: styles.increase,
  DECREASE: styles.decrease,
  SAME: styles.same,
};

export function PriceComparison({ line }) {
  // Absent history is stated plainly. Showing "Rs 0" or "0%" here would
  // falsely assert that the price had not moved.
  if (!line.previous_purchase_unit_price) {
    return <span className={styles.none}>No previous purchase history</span>;
  }

  const sign = line.price_direction === "INCREASE" ? "+" : "";
  const difference = `${sign}${formatPkr(line.price_difference)}`;
  const percentage = `${sign}${line.price_difference_percentage}%`;

  return (
    <span className={[styles.comparison, DIRECTION_CLASS[line.price_direction]].join(" ")}>
      <span className={styles.previous}>
        Previous actual {formatPkr(line.previous_purchase_unit_price)}
        {line.previous_purchase_ipo_number ? ` · ${line.previous_purchase_ipo_number}` : ""}
      </span>
      <strong>
        {difference} ({percentage})
      </strong>
      <span className={styles.direction}>{DIRECTION_LABEL[line.price_direction]}</span>
    </span>
  );
}
