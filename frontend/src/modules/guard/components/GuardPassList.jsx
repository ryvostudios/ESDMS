import { useNavigate } from "react-router-dom";
import { GatePassStatusBadge } from "../../gate-pass/components/GatePassStatusBadge.jsx";
import styles from "./GuardPassList.module.css";

export function GuardPassList({ rows, emptyMessage }) {
  const navigate = useNavigate();

  if (rows.length === 0) {
    return <p className={styles.empty}>{emptyMessage}</p>;
  }

  return (
    <div className={styles.list}>
      {rows.map((gatePass) => (
        <div
          key={gatePass.id}
          className={styles.row}
          onClick={() => navigate(`/guard/gate-passes/${gatePass.id}`, { state: { gatePass } })}
        >
          <div className={styles.info}>
            <span className={styles.number}>{gatePass.gatePassNumber}</span>
            <span className={styles.meta}>
              {gatePass.vehicleRegistration} · {gatePass.driverName}
            </span>
          </div>
          <GatePassStatusBadge status={gatePass.status} />
        </div>
      ))}
    </div>
  );
}
