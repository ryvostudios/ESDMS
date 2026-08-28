import { useEffect, useState } from "react";
import styles from "./ProfilePhoto.module.css";

export function ProfilePhoto({ load, alt, refreshKey = 0 }) {
  const [url, setUrl] = useState(null);

  useEffect(() => {
    let active = true;
    let objectUrl;
    if (typeof load !== "function") return undefined;
    load()
      .then((blob) => {
        if (!active) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (active) setUrl(null);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [load, refreshKey]);

  return url ? <img className={styles.photo} src={url} alt={alt} /> : null;
}
