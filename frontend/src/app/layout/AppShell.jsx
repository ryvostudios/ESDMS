import { useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar.jsx";
import { TopBar } from "./TopBar.jsx";
import { MobileNav } from "./MobileNav.jsx";
import styles from "./AppShell.module.css";

export function AppShell() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const menuButtonRef = useRef(null);

  return (
    <div className={styles.shell}>
      <Sidebar />
      <MobileNav open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} triggerRef={menuButtonRef} />
      <div className={styles.main}>
        <TopBar onOpenMenu={() => setMobileNavOpen(true)} menuButtonRef={menuButtonRef} menuOpen={mobileNavOpen} />
        <main id="main-content" className={styles.content}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
