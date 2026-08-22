import { useEffect, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { getGuardGatePass } from "../api.js";
import { GuardActionView } from "../components/GuardActionView.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";

// Client-side classification only for display purposes — the exit/return
// endpoints independently re-check current state server-side, so a stale
// client computation here can never cause an invalid transition.
function classify(status) {
  if (status === "APPROVED") return { allowedAction: "EXIT", reason: null };
  if (status === "VEHICLE_OUTSIDE") return { allowedAction: "RETURN", reason: null };
  return { allowedAction: null, reason: `This Gate Pass is ${status.replaceAll("_", " ").toLowerCase()}.` };
}

export function GuardActionPage() {
  const { id } = useParams();
  const location = useLocation();

  // Navigating here from the dashboard/search already has the row in hand
  // — reuse it instead of an extra round trip. A refresh or direct link
  // loses this state entirely, which the effect below covers.
  const navigationGatePass = location.state?.gatePass?.id === id ? location.state.gatePass : null;

  const [gatePass, setGatePass] = useState(navigationGatePass);
  const [status, setStatus] = useState(navigationGatePass ? "ready" : "loading");
  const [error, setError] = useState(null);

  useEffect(() => {
    if (navigationGatePass) {
      return;
    }

    let cancelled = false;

    getGuardGatePass(id)
      .then((response) => {
        if (!cancelled) {
          setGatePass(response.data);
          setStatus("ready");
        }
      })
      .catch((requestError) => {
        if (!cancelled) {
          setError(requestError.message || "Unable to load this Gate Pass.");
          setStatus("error");
        }
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const { allowedAction, reason } = gatePass ? classify(gatePass.status) : {};

  return (
    <div>
      <PageHeader title="Gate Pass" />
      {status === "loading" && <LoadingState message="Loading…" />}
      {status === "error" && <ErrorState message={error} />}
      {status === "ready" && <GuardActionView gatePass={gatePass} allowedAction={allowedAction} reason={reason} />}
    </div>
  );
}
