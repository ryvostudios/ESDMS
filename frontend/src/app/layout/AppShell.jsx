import { ApplicationNotice } from "../../modules/cms/ApplicationNotice.jsx";
import { useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar.jsx";
import { TopBar } from "./TopBar.jsx";
import { MobileNav } from "./MobileNav.jsx";
import { AppMeshBackground } from "./AppMeshBackground.jsx";
import styles from "./AppShell.module.css";

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef(null);
  // The mesh's own container is pointer-events:none (it must never
  // intercept clicks/scroll), so it never receives pointer events itself.
  // .main IS the real hit-testable owner — TopBar and page content live
  // inside it — so pointer tracking listens there instead; see
  // AppMeshBackground's interactionRef prop.
  const mainRef = useRef(null);

  return (
    <div className={styles.shell}>
      <Sidebar />
      <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} triggerRef={menuButtonRef} />
      <div className={styles.main} ref={mainRef}>
        <div className={styles.mesh}>
          <AppMeshBackground interactionRef={mainRef} />
        </div>
        <TopBar onOpenMenu={() => setMobileNavOpen(true)} menuButtonRef={menuButtonRef} menuOpen={mobileNavOpen} />
        <main id="main-content" className={styles.content}>
          <ApplicationNotice />
          <Outlet />
        </main>
      </div>
    </div>
  );
}
