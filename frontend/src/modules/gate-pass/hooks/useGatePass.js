import { useCallback, useEffect, useState } from "react";
import { getGatePass } from "../api.js";

export function useGatePass(id) {
  const [gatePass, setGatePass] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setStatus("loading");
    setError(null);

    return getGatePass(id)
      .then((response) => {
        setGatePass(response.data);
        setStatus("ready");
      })
      .catch((requestError) => {
        setError(requestError.message || "Unable to load this Gate Pass.");
        setStatus("error");
      });
  }, [id]);

  useEffect(() => {
    // Needed on every refetch (id change or manual reload), not just
    // mount, so lazy initial state can't substitute for this.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { gatePass, status, error, reload: load };
}
