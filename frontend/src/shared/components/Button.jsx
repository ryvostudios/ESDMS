import styles from "./Button.module.css";

const VARIANT_CLASS = {
  primary: styles.primary,
  secondary: styles.secondary,
  danger: styles.danger,
  ghost: styles.ghost,
};

export function Button({
  variant = "primary",
  loading = false,
  disabled = false,
  type = "button",
  children,
  className,
  ...rest
}) {
  const classes = [styles.button, VARIANT_CLASS[variant], className].filter(Boolean).join(" ");

  return (
    <button type={type} className={classes} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span className={styles.spinner} aria-hidden="true" />}
      <span className={loading ? styles.labelLoading : undefined}>{children}</span>
    </button>
  );
}
