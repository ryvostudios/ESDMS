import { useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ApiError } from "../../../core/api/client.js";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input } from "../../../shared/components/FormField.jsx";
import styles from "./LoginPage.module.css";

export function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  if (status === "authenticated") {
    const redirectTo = location.state?.from?.pathname || "/";
    return <Navigate to={redirectTo} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (submitting) return;

    const nextFieldErrors = {};
    if (!email.trim()) nextFieldErrors.email = "Email is required.";
    if (!password) nextFieldErrors.password = "Password is required.";
    setFieldErrors(nextFieldErrors);
    setFormError(null);

    if (Object.keys(nextFieldErrors).length > 0) {
      return;
    }

    setSubmitting(true);

    try {
      await login(email, password);
    } catch (error) {
      if (error instanceof ApiError) {
        setFormError(error.message);
      } else {
        setFormError("Unable to reach the server. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.screen}>
      <div className={styles.brandPanel}>
        <span className={styles.brandMark} aria-hidden="true">
          ES
        </span>
        <div className={styles.brandCopy}>
          <h2>E-Set Digital Management System</h2>
          <p>Controlled, auditable Gate Pass operations for vehicle and driver movement across E-Set sites.</p>
        </div>
        <p className={styles.brandFooter}>© {new Date().getFullYear()} E-Set</p>
      </div>

      <div className={styles.formPanel}>
        <div className={styles.formCard}>
          <div className={styles.mobileBrand}>
            <span className={styles.mobileBrandMark} aria-hidden="true">
              ES
            </span>
            <span className={styles.mobileBrandName}>E-Set DMS</span>
          </div>

          <div className={styles.heading}>
            <h1>Sign in</h1>
            <p>Use your E-Set account to continue.</p>
          </div>

          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            {formError && (
              <div className={styles.formError} role="alert">
                {formError}
              </div>
            )}

            <FormField label="Email" htmlFor="email" required error={fieldErrors.email}>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                error={fieldErrors.email}
                disabled={submitting}
              />
            </FormField>

            <FormField label="Password" htmlFor="password" required error={fieldErrors.password}>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                error={fieldErrors.password}
                disabled={submitting}
              />
            </FormField>

            <Button type="submit" className={styles.submit} loading={submitting}>
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
