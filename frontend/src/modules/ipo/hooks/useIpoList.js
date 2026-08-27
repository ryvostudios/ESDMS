import { useCallback, useEffect, useState } from "react";
import { listIpos } from "../api.js";

export function useIpoList(filters) {
  const [state, setState] = useState({ rows: [], total: 0, status: "loading", error: null });
  const { search, status: statusFilter, page, pageSize } = filters;

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return listIpos({ search, status: statusFilter, page, pageSize })
      .then((response) =>
        setState({ rows: response.data, total: response.meta.total, status: "ready", error: null }),
      )
      .catch((error) =>
        setState((current) => ({
          ...current,
          status: "error",
          error: error.message || "Unable to load IPOs.",
        })),
      );
  }, [search, statusFilter, page, pageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { ...state, reload: load };
}
