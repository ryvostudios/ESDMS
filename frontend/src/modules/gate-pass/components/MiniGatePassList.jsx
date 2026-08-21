import { useNavigate } from "react-router-dom";
import { GatePassStatusBadge } from "./GatePassStatusBadge.jsx";
import styles from "./MiniGatePassList.module.css";

export function MiniGatePassList({ rows, emptyMessage }) {
  const navigate = useNavigate();

  if (rows.length === 0) {
    return <p className={styles.empty}>{emptyMessage}</p>;
  }

  return (
    <div className={styles.list}>
      {rows.map((gatePass) => (
        <div key={gatePass.id} className={styles.row} onClick={() => navigate(`/gate-passes/${gatePass.id}`)}>
          <div className={styles.info}>
            <span className={styles.number}>{gatePass.gatePassNumber}</span>
            <span className={styles.meta}>
              {gatePass.destination} · {gatePass.vehicleRegistration}
            </span>
          </div>
          <GatePassStatusBadge status={gatePass.status} />
        </div>
      ))}
    </div>
  );
}
