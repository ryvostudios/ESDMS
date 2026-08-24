import { useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ApiError } from "../../../core/api/client.js";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input } from "../../../shared/components/FormField.jsx";
import { LoginMeshBackground } from "./LoginMeshBackground.jsx";
import { LoginKineticBackground } from "./LoginKineticBackground.jsx";
import styles from "./LoginPage.module.css";

// Wraps Input so FormField's aria-describedby cloning (it clones its
// `children` element directly) still lands on the actual <input>, not on
// a wrapping div — the toggle button sits alongside via CSS, not as a
// sibling FormField would need to know about.
function PasswordInput({ visible, onToggleVisible, ...inputProps }) {
  return (
    <div className={styles.passwordWrapper}>
      <Input {...inputProps} type={visible ? "text" : "password"} className={styles.passwordInput} />
      <button
        type="button"
        className={styles.togglePassword}
        onClick={onToggleVisible}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-pressed={visible}
      >
        {visible ? "Hide" : "Show"}
      </button>
    </div>
  );
}

export function LoginPage() {
  const { status, login } = useAuth();
  const location = useLocation();
  // The grid's own container is pointer-events:none, so it never receives
  // pointer events itself — the brand panel IS the real hit-testable owner
  // (mark/copy/footer live inside it), so pointer tracking listens there
  // instead; see LoginKineticBackground's interactionRef prop.
  const brandPanelRef = useRef(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
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
      await login(email, password, rememberMe);
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
      <LoginMeshBackground />
      <div className={styles.brandPanel} ref={brandPanelRef}>
        <div className={styles.brandGrid}>
          <LoginKineticBackground interactionRef={brandPanelRef} />
        </div>
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
            {!formError && location.state?.info && (
              // e.g. after a password change intentionally invalidates the
              // session (ESDMS-020) — a confirmation, not an error.
              <div className={styles.formError} role="status">
                {location.state.info}
              </div>
            )}
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
              <PasswordInput
                id="password"
                name="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                error={fieldErrors.password}
                disabled={submitting}
                visible={passwordVisible}
                onToggleVisible={() => setPasswordVisible((current) => !current)}
              />
            </FormField>

            <label className={styles.rememberMe}>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(event) => setRememberMe(event.target.checked)}
                disabled={submitting}
              />
              Keep me signed in for 7 days
            </label>

            <Button type="submit" className={styles.submit} loading={submitting}>
              Sign in
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
