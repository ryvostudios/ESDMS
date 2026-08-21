import { useEffect, useState } from "react";
import { listDepartments } from "../api.js";

export function useDepartments() {
  const [departments, setDepartments] = useState([]);
  const [status, setStatus] = useState("loading");

  useEffect(() => {
    let cancelled = false;

    listDepartments()
      .then((response) => {
        if (!cancelled) {
          setDepartments(response.data);
          setStatus("ready");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { departments, status };
}
