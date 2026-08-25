import { useCallback, useEffect, useState } from "react";
import { listDemands } from "../api.js";

export function useDemandList({ status, search, page, pageSize }) {
  const [data, setData] = useState({ rows: [], total: 0 });
  const [status_, setStatus_] = useState("loading");
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus_("loading");
    setError(null);

    listDemands({ status, search, page, pageSize })
      .then((response) => {
        if (cancelled) return;
        setData({ rows: response.data, total: response.meta.total });
        setStatus_("ready");
      })
      .catch((requestError) => {
        if (cancelled) return;
        setError(requestError.message || "Unable to load Demands.");
        setStatus_("error");
      });

    return () => {
      cancelled = true;
    };
  }, [status, search, page, pageSize, reloadToken]);

  return { rows: data.rows, total: data.total, status: status_, error, reload };
}
