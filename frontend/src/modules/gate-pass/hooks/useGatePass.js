import { useCallback, useEffect, useState } from "react";
import { getGatePass } from "../api.js";

export function useGatePass(id) {
  const [gatePass, setGatePass] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  // `silent` skips the loading-state flash — used for background polling
  // (see GatePassDetailPage's PDF-readiness poll) where re-showing the
  // full-page spinner on every tick would be a worse experience than just
  // updating the data once it arrives.
  const load = useCallback(
    ({ silent = false } = {}) => {
      if (!silent) {
        setStatus("loading");
        setError(null);
      }

      return getGatePass(id)
        .then((response) => {
          setGatePass(response.data);
          setStatus("ready");
        })
        .catch((requestError) => {
          if (!silent) {
            setError(requestError.message || "Unable to load this Gate Pass.");
            setStatus("error");
          }
        });
    },
    [id],
  );

  useEffect(() => {
    // Needed on every refetch (id change or manual reload), not just
    // mount, so lazy initial state can't substitute for this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { gatePass, status, error, reload: load };
}
