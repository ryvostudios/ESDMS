import styles from "./BarList.module.css";

const TONE_CLASS = {
  neutral: styles.neutral,
  primary: styles.primary,
  warning: styles.warning,
  danger: styles.danger,
  success: styles.success,
  info: styles.info,
};

// Compact horizontal bar comparison — a count/label per row, width relative
// to the largest value present. Used where a proportion/comparison across
// a handful of categories is genuinely useful (e.g. status distribution),
// not as decoration.
export function BarList({ items }) {
  const max = Math.max(1, ...items.map((item) => item.value));

  return (
    <ul className={styles.list}>
      {items.map((item) => (
        <li key={item.label} className={styles.row}>
          <span className={styles.label}>{item.label}</span>
          <div className={styles.track}>
            <div
              className={[styles.fill, TONE_CLASS[item.tone]].filter(Boolean).join(" ")}
              style={{ width: `${(item.value / max) * 100}%` }}
            />
          </div>
          <span className={styles.value}>{item.value}</span>
        </li>
      ))}
    </ul>
  );
}
