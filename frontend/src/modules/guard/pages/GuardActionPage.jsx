import { useLocation, useNavigate, useParams } from "react-router-dom";
import { GuardActionView } from "../components/GuardActionView.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { EmptyState } from "../../../shared/components/StatePanel.jsx";
import { Button } from "../../../shared/components/Button.jsx";

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
  const navigate = useNavigate();

  const gatePass = location.state?.gatePass;

  if (!gatePass || gatePass.id !== id) {
    return (
      <div>
        <PageHeader title="Gate Pass" />
        <EmptyState
          title="Open this from the Gate dashboard"
          message="This page needs to be reached from a dashboard or search result — reloading directly isn't supported yet."
          action={<Button onClick={() => navigate("/guard")}>Back to Gate</Button>}
        />
      </div>
    );
  }

  const { allowedAction, reason } = classify(gatePass.status);

  return (
    <div>
      <PageHeader title="Gate Pass" />
      <GuardActionView gatePass={gatePass} allowedAction={allowedAction} reason={reason} />
    </div>
  );
}
