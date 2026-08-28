import { useCallback, useEffect, useState } from "react";
import { getIpo } from "../api.js";

export function useIpo(id) {
  const [state, setState] = useState({ result: null, status: "loading", error: null });

  const load = useCallback(() => {
    setState((current) => ({ ...current, status: "loading", error: null }));
    return getIpo(id)
      .then((response) => setState({ result: response.data, status: "ready", error: null }))
      .catch((error) =>
        setState({ result: null, status: "error", error }),
      );
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return { ...state, reload: load };
}
