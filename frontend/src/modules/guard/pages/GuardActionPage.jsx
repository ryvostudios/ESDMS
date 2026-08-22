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

  // Navigation state is an optimistic skeleton ONLY — it makes the loading
  // message name the actual Gate Pass instead of a bare spinner, nothing
  // more. Whether EXIT/RETURN is even offered always comes from the fetch
  // below, on every visit, not just a refresh — a second Guard could have
  // recorded the exit between when this list was fetched and now, and this
  // page must catch that before ever showing an action form, not after the
  // first Guard has already uploaded a photo.
  const navigationGatePass = location.state?.gatePass?.id === id ? location.state.gatePass : null;

  const [gatePass, setGatePass] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
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
  }, [id]);

  const { allowedAction, reason } = gatePass ? classify(gatePass.status) : {};

  return (
    <div>
      <PageHeader title="Gate Pass" />
      {status === "loading" && (
        <LoadingState message={navigationGatePass ? `Confirming ${navigationGatePass.gatePassNumber}…` : "Loading…"} />
      )}
      {status === "error" && <ErrorState message={error} />}
      {status === "ready" && <GuardActionView gatePass={gatePass} allowedAction={allowedAction} reason={reason} />}
    </div>
  );
}
