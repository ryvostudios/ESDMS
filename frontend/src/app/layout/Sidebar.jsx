import { useRef } from "react";
import { NavList } from "./NavList.jsx";
import { SidebarKineticBackground } from "./SidebarKineticBackground.jsx";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  // The grid's own container is pointer-events:none, so it never receives
  // pointer events itself — the <aside> IS the real hit-testable owner
  // (brand + nav live inside it), so pointer tracking listens there
  // instead; see SidebarKineticBackground's interactionRef prop.
  const sidebarRef = useRef(null);

  return (
    <aside className={styles.sidebar} ref={sidebarRef}>
      <div className={styles.grid}>
        <SidebarKineticBackground interactionRef={sidebarRef} />
      </div>
      <div className={styles.brand}>
        <span className={styles.brandMark} aria-hidden="true">
          ES
        </span>
        <span className={styles.brandText}>
          <span className={styles.brandName}>E-Set DMS</span>
          <span className={styles.brandSub}>Gate Pass</span>
        </span>
      </div>
      <NavList />
    </aside>
  );
}
