import { useCallback, useEffect, useState } from "react";
import { getDemand } from "../api.js";

export function useDemand(id) {
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setStatus("loading");
    setError(null);

    return getDemand(id)
      .then((response) => {
        setResult(response.data);
        setStatus("ready");
      })
      .catch((requestError) => {
        setError(requestError.message || "Unable to load this Demand.");
        setStatus("error");
      });
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { result, status, error, reload: load };
}
