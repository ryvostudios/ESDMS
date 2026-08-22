import { useEffect, useState } from "react";
import { verifyByToken } from "../api.js";
import { GuardActionView } from "../components/GuardActionView.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";

export function GuardVerifyPage() {
  // The token travels as a URL fragment (#token), not a path segment or
  // query string — the browser never sends a fragment to the server, so it
  // never appears in access/proxy logs when this page's link is opened.
  // Read once on mount; it never changes without a full page navigation.
  const [token] = useState(() => window.location.hash.slice(1));
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState(token ? "loading" : "error");
  const [error, setError] = useState(token ? null : "This link is missing its verification code.");

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    let cancelled = false;

    verifyByToken(token)
      .then((response) => {
        if (!cancelled) {
          setResult(response.data);
          setStatus("ready");
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError.message || "Unable to verify this Gate Pass.");
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div>
      <PageHeader title="Verify Gate Pass" />
      {status === "loading" && <LoadingState message="Verifying…" />}
      {status === "error" && <ErrorState message={error} />}
      {status === "ready" && (
        <GuardActionView gatePass={result.gatePass} allowedAction={result.allowedAction} reason={result.reason} />
      )}
    </div>
  );
}
