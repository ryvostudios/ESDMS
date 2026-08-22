import { Link } from "react-router-dom";
import { GatePassStatusBadge } from "./GatePassStatusBadge.jsx";
import styles from "./MiniGatePassList.module.css";

export function MiniGatePassList({ rows, emptyMessage }) {
  if (rows.length === 0) {
    return <p className={styles.empty}>{emptyMessage}</p>;
  }

  return (
    <div className={styles.list}>
      {rows.map((gatePass) => (
        <Link key={gatePass.id} to={`/gate-passes/${gatePass.id}`} className={styles.row}>
          <div className={styles.info}>
            <span className={styles.number}>{gatePass.gatePassNumber}</span>
            <span className={styles.meta}>
              {gatePass.destination} · {gatePass.vehicleRegistration}
            </span>
          </div>
          <GatePassStatusBadge status={gatePass.status} />
        </Link>
      ))}
    </div>
  );
}
