import styles from "./StatusBadge.module.css";

const TONE_CLASS = {
  neutral: styles.neutral,
  warning: styles.warning,
  info: styles.info,
  success: styles.success,
  danger: styles.danger,
};

// Status is conveyed by label text as well as color/dot — never color alone.
export function StatusBadge({ tone = "neutral", label }) {
  return (
    <span className={[styles.badge, TONE_CLASS[tone]].join(" ")}>
      <span className={styles.dot} aria-hidden="true" />
      {label}
    </span>
  );
}
