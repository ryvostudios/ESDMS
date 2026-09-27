import { useEffect, useRef } from "react";
import { NavList } from "./NavList.jsx";
import { CloseIcon } from "../../shared/icons.jsx";
import { MobileKineticBackground } from "../../shared/components/MobileKineticBackground.jsx";
import { useCompanyLogo } from "../../modules/cms/company-logo.js";
import { CompanyMark } from "../../modules/cms/CompanyMark.jsx";
import styles from "./MobileNav.module.css";

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function MobileNav({ open, onClose, triggerRef }) {
  const logoUrl = useCompanyLogo();
  const closeButtonRef = useRef(null);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    closeButtonRef.current?.focus();

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      // Focus trap: while the drawer is open, Tab/Shift+Tab must stay
      // within it rather than escaping into the backdrop-covered page.
      if (event.key === "Tab") {
        const focusable = Array.from(drawerRef.current?.querySelectorAll(FOCUSABLE_SELECTOR) ?? []);
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
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
      <div
        id="mobile-nav-drawer"
        className={styles.drawer}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
        ref={drawerRef}
      >
        {/* The drawer only ever exists in the DOM while `open` is true (see
            the early `return null` above) — mounting the grid here means it
            fully unmounts, cleaning up its RAF loop/listeners, the instant
            the drawer closes. No "hidden but still running" state is
            possible for this one, unlike the always-mounted desktop sidebar. */}
        <div className={styles.grid}>
          <MobileKineticBackground interactionRef={drawerRef} />
        </div>
        <div className={styles.header}>
          <div className={styles.brand}>
            <CompanyMark logoUrl={logoUrl} logoClassName={styles.brandLogo} fallbackClassName={styles.brandMark} />
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
