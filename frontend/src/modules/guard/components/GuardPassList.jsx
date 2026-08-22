import { Link } from "react-router-dom";
import { GatePassStatusBadge } from "../../gate-pass/components/GatePassStatusBadge.jsx";
import styles from "./GuardPassList.module.css";

export function GuardPassList({ rows, emptyMessage }) {
  if (rows.length === 0) {
    return <p className={styles.empty}>{emptyMessage}</p>;
  }

  return (
    <div className={styles.list}>
      {rows.map((gatePass) => (
        <Link
          key={gatePass.id}
          to={`/guard/gate-passes/${gatePass.id}`}
          state={{ gatePass }}
          className={styles.row}
        >
          <div className={styles.info}>
            <span className={styles.number}>{gatePass.gatePassNumber}</span>
            <span className={styles.meta}>
              {gatePass.vehicleRegistration} · {gatePass.driverName}
            </span>
          </div>
          <GatePassStatusBadge status={gatePass.status} />
        </Link>
      ))}
    </div>
  );
}
