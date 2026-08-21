import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { verifyByToken } from "../api.js";
import { GuardActionView } from "../components/GuardActionView.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";

export function GuardVerifyPage() {
  const { token } = useParams();
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
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
