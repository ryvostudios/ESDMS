import { useState } from "react";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { ApiError } from "../../core/api/client.js";
import { formatEnumLabel } from "../../shared/utilities/format.js";
import { MenuIcon, LogoutIcon } from "../../shared/icons.jsx";
import { NotificationBell } from "./NotificationBell.jsx";
import styles from "./TopBar.module.css";

export function TopBar({ onOpenMenu, menuButtonRef, menuOpen }) {
  const { user, logout } = useAuth();
  const [logoutError, setLogoutError] = useState(null);

  async function handleLogout() {
    setLogoutError(null);

    try {
      await logout();
    } catch (error) {
      setLogoutError(error instanceof ApiError ? error.message : "Unable to reach the server. Please try again.");
    }
  }

  return (
    <header className={styles.topbar}>
      <button
        ref={menuButtonRef}
        type="button"
        className={styles.menuButton}
        onClick={onOpenMenu}
        aria-label="Open navigation menu"
        aria-expanded={menuOpen}
        aria-controls="mobile-nav-drawer"
      >
        <MenuIcon />
      </button>

      <div className={styles.spacer} />

      <div className={styles.userMenu}>
        <NotificationBell />
        <div className={styles.userInfo}>
          <span className={styles.userName}>{user.fullName}</span>
          <span className={styles.roleBadge}>{formatEnumLabel(user.role)}</span>
        </div>
        {logoutError && (
          <span className={styles.logoutError} role="alert">
            {logoutError}
          </span>
        )}
        <button type="button" className={styles.logoutButton} onClick={handleLogout}>
          <LogoutIcon width={16} height={16} />
          Log out
        </button>
      </div>
    </header>
  );
}
