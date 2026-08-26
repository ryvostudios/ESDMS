import { useCallback, useEffect, useState } from "react";
import { getPricing } from "../api.js";

export function usePricing(demandId, version = null) {
  const [result, setResult] = useState(null);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setStatus("loading");
    setError(null);
    return getPricing(demandId, version)
      .then((response) => {
        setResult(response.data);
        setStatus("ready");
        return response.data;
      })
      .catch((requestError) => {
        setError(requestError.message || "Unable to load Procurement pricing.");
        setStatus("error");
        throw requestError;
      });
  }, [demandId, version]);

  useEffect(() => {
    // The rejection is reflected in state; avoid an unhandled promise from
    // this mount-only load while preserving rejection for explicit reloads.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load().catch(() => {});
  }, [load]);

  return { result, status, error, reload: load };
}
