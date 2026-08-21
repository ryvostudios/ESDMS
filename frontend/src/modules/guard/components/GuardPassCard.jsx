import { GatePassStatusBadge } from "../../gate-pass/components/GatePassStatusBadge.jsx";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import styles from "./GuardPassCard.module.css";

function Field({ label, value }) {
  return (
    <div className={styles.field}>
      <dt>{label}</dt>
      <dd>{value || "—"}</dd>
    </div>
  );
}

export function GuardPassCard({ gatePass }) {
  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <h1 className={styles.number}>{gatePass.gatePassNumber}</h1>
        <GatePassStatusBadge status={gatePass.status} />
      </div>
      <dl className={styles.grid}>
        <Field label="Destination" value={gatePass.destination} />
        <Field label="Purpose" value={formatEnumLabel(gatePass.purpose)} />
        <Field label="Driver" value={gatePass.driverName} />
        <Field label="Driver Phone" value={gatePass.driverPhone} />
        <Field label="Vehicle Registration" value={gatePass.vehicleRegistration} />
        {gatePass.expectedReturnDate && (
          <Field label="Expected Return" value={new Date(gatePass.expectedReturnDate).toLocaleDateString()} />
        )}
      </dl>
      <p className={styles.driverHint}>Confirm the driver's ID matches the record above before proceeding.</p>
    </div>
  );
}
