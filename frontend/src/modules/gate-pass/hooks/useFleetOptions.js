import { useEffect, useState } from "react";
import { listDrivers, listVehicles } from "../../fleet/api.js";

// Active Driver/Vehicle master rows for the Gate Pass form's pickers.
//
// Failing to load is deliberately NOT an error state for the form: the pass
// can still be raised with free-text driver and vehicle details, so a
// picker that cannot load degrades to the manual path rather than blocking
// someone at the gate.
export function useFleetOptions(canView) {
  const [drivers, setDrivers] = useState([]);
  const [vehicles, setVehicles] = useState([]);

  useEffect(() => {
    if (!canView) return undefined;

    let cancelled = false;

    Promise.allSettled([listDrivers(), listVehicles()]).then(([driverResult, vehicleResult]) => {
      if (cancelled) return;
      if (driverResult.status === "fulfilled") setDrivers(driverResult.value.data);
      if (vehicleResult.status === "fulfilled") setVehicles(vehicleResult.value.data);
    });

    return () => {
      cancelled = true;
    };
  }, [canView]);

  return { drivers, vehicles };
}
