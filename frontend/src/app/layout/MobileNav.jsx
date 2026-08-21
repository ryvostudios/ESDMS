import { useEffect, useRef } from "react";
import { NavList } from "./NavList.jsx";
import { CloseIcon } from "../../shared/icons.jsx";
import styles from "./MobileNav.module.css";

export function MobileNav({ open, onClose, triggerRef }) {
  const closeButtonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    closeButtonRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.addEventListener("keydown", handleKeyDown);

    const triggerElement = triggerRef?.current;
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      triggerElement?.focus();
    };
  }, [open, onClose, triggerRef]);

  if (!open) {
    return null;
  }

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="Navigation menu">
        <div className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.brandMark} aria-hidden="true">
              ES
            </span>
            <span className={styles.brandName}>E-Set DMS</span>
          </div>
          <button ref={closeButtonRef} type="button" className={styles.closeButton} onClick={onClose} aria-label="Close navigation menu">
            <CloseIcon />
          </button>
        </div>
        <NavList onNavigate={onClose} />
      </div>
    </>
  );
}
