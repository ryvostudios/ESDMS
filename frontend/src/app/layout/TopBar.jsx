import { useAuth } from "../../core/auth/AuthContext.jsx";
import { formatEnumLabel } from "../../shared/utilities/format.js";
import { MenuIcon, LogoutIcon } from "../../shared/icons.jsx";
import { NotificationBell } from "./NotificationBell.jsx";
import styles from "./TopBar.module.css";

export function TopBar({ onOpenMenu, menuButtonRef }) {
  const { user, logout } = useAuth();

  return (
    <header className={styles.topbar}>
      <button
        ref={menuButtonRef}
        type="button"
        className={styles.menuButton}
        onClick={onOpenMenu}
        aria-label="Open navigation menu"
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
        <button type="button" className={styles.logoutButton} onClick={logout}>
          <LogoutIcon width={16} height={16} />
          Log out
        </button>
      </div>
    </header>
  );
}
