import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { GuardPassCard } from "./GuardPassCard.jsx";
import { GateActionForm } from "./GateActionForm.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { recordExit, recordReturn } from "../api.js";
import styles from "./GuardActionView.module.css";

export function GuardActionView({ gatePass, allowedAction, reason }) {
  const navigate = useNavigate();
  const [completed, setCompleted] = useState(null);

  async function handleSubmit({ odometer, photo, remarks }) {
    if (allowedAction === "EXIT") {
      await recordExit(gatePass.id, { odometer, photo });
      setCompleted("EXIT");
    } else if (allowedAction === "RETURN") {
      await recordReturn(gatePass.id, { odometer, photo, remarks });
      setCompleted("RETURN");
    }
  }

  if (completed) {
    return (
      <div>
        <GuardPassCard gatePass={{ ...gatePass, status: completed === "EXIT" ? "VEHICLE_OUTSIDE" : "COMPLETED" }} />
        <div className={styles.success}>
          <p className={styles.successTitle}>
            {completed === "EXIT" ? "Vehicle exit recorded" : "Vehicle return recorded"}
          </p>
          <Button onClick={() => navigate("/guard")}>Back to Gate</Button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <GuardPassCard gatePass={gatePass} />
      {allowedAction === "EXIT" || allowedAction === "RETURN" ? (
        <GateActionForm
          mode={allowedAction}
          minOdometer={allowedAction === "RETURN" ? gatePass.departureOdometer : null}
          onSubmit={handleSubmit}
        />
      ) : (
        <p className={styles.blocked}>{reason || "No action is available for this Gate Pass right now."}</p>
      )}
    </div>
  );
}
