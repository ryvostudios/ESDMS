import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { apiClient, ApiError } from "../../../core/api/client.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input } from "../../../shared/components/FormField.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";

// Reached either as a forced redirect (mustChangePassword=true — see
// ProtectedRoute.jsx) or voluntarily from the top bar. The backend is the
// real enforcement boundary (requirePermission/requirePasswordChanged);
// this page exists so that boundary has somewhere to send the user.
export function ChangePasswordPage() {
  const { refreshUser } = useAuth();
  const navigate = useNavigate();

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    setError(null);

    if (newPassword.length < 12) {
      setError("New password must be at least 12 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("New password and confirmation do not match.");
      return;
    }

    setSubmitting(true);
    try {
      await apiClient.post("/auth/change-password", { currentPassword, newPassword });
      await refreshUser();
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to change password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "0 auto" }}>
      <PageHeader title="Change your password" description="Set a new password to continue." />
      <form onSubmit={handleSubmit} noValidate>
        {error && (
          <p role="alert" style={{ color: "var(--color-danger, #b42318)", marginBottom: 12 }}>
            {error}
          </p>
        )}
        <FormField label="Current password" htmlFor="currentPassword" required>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={submitting}
          />
        </FormField>
        <FormField label="New password" htmlFor="newPassword" required hint="At least 12 characters.">
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
          />
        </FormField>
        <FormField label="Confirm new password" htmlFor="confirmPassword" required>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
          />
        </FormField>
        <Button type="submit" loading={submitting}>
          Change password
        </Button>
      </form>
    </div>
  );
}
