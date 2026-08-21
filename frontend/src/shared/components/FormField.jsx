import { forwardRef } from "react";
import styles from "./FormField.module.css";

export const Input = forwardRef(function Input({ className, error, ...rest }, ref) {
  const classes = [styles.input, className].filter(Boolean).join(" ");
  return <input ref={ref} className={classes} aria-invalid={Boolean(error) || undefined} {...rest} />;
});

export const Textarea = forwardRef(function Textarea({ className, error, ...rest }, ref) {
  const classes = [styles.input, className].filter(Boolean).join(" ");
  return <textarea ref={ref} className={classes} aria-invalid={Boolean(error) || undefined} {...rest} />;
});

export const Select = forwardRef(function Select({ className, error, children, ...rest }, ref) {
  const classes = [styles.input, className].filter(Boolean).join(" ");
  return (
    <select ref={ref} className={classes} aria-invalid={Boolean(error) || undefined} {...rest}>
      {children}
    </select>
  );
});

export function FormField({ label, htmlFor, required, error, hint, children }) {
  return (
    <div className={styles.field}>
      <label htmlFor={htmlFor} className={styles.label}>
        {label}
        {required && (
          <span className={styles.required} aria-hidden="true">
            {" "}
            *
          </span>
        )}
      </label>
      {children}
      {hint && !error && <p className={styles.hint}>{hint}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
