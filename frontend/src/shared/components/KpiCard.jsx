import styles from "./KpiCard.module.css";

const TONE_CLASS = {
  neutral: styles.neutral,
  primary: styles.primary,
  warning: styles.warning,
  danger: styles.danger,
  success: styles.success,
};

// Compact KPI summary card — used by Dashboard and Workforce Dashboard.
// `value` is whatever the caller already computed from real API data; this
// component only presents it.
export function KpiCard({ icon: Icon, label, value, context, tone = "neutral" }) {
  return (
    <div className={styles.card}>
      {Icon && (
        <span className={[styles.icon, TONE_CLASS[tone]].filter(Boolean).join(" ")} aria-hidden="true">
          <Icon width={18} height={18} />
        </span>
      )}
      <div className={styles.body}>
        <span className={styles.value}>{value}</span>
        <span className={styles.label}>{label}</span>
        {context && <span className={styles.context}>{context}</span>}
      </div>
    </div>
  );
}
