import { useCallback, useEffect, useState } from "react";
import { listPricingQueue } from "../api.js";

export function usePricingQueue(filters) {
  const [state, setState] = useState({ rows: [], total: 0, status: "loading", error: null });
  const { search, page, pageSize } = filters;

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return listPricingQueue({ search, page, pageSize })
      .then((response) => {
        setState({ rows: response.data, total: response.meta.total, status: "ready", error: null });
      })
      .catch((error) => {
        setState((current) => ({
          ...current,
          status: "error",
          error: error.message || "Unable to load the Procurement queue.",
        }));
      });
  }, [search, page, pageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { ...state, reload: load };
}

