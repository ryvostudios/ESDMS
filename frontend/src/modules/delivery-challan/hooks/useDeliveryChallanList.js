import { useCallback, useEffect, useState } from "react";
import { listDeliveryChallans } from "../api.js";

// Mirrors useIpoList exactly — same shape, same states — so the two list pages
// stay interchangeable to read and maintain.
export function useDeliveryChallanList(filters) {
  const [state, setState] = useState({ rows: [], total: 0, status: "loading", error: null });
  const { search, status: statusFilter, page, pageSize } = filters;

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return listDeliveryChallans({ search, status: statusFilter, page, pageSize })
      .then((response) =>
        setState({ rows: response.data, total: response.meta.total, status: "ready", error: null }),
      )
      .catch((error) =>
        setState((current) => ({
          ...current,
          status: "error",
          error: error.message || "Unable to load Delivery Challans.",
        })),
      );
  }, [search, statusFilter, page, pageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { ...state, reload: load };
}
