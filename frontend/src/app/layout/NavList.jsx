import { NavLink } from "react-router-dom";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { NAV_ITEMS } from "./navigation.js";
import styles from "./Sidebar.module.css";

export function NavList({ onNavigate }) {
  const { hasPermission } = useAuth();

  return (
    <nav className={styles.nav} aria-label="Primary">
      {NAV_ITEMS.filter(({ permission }) => !permission || hasPermission(...permission)).map(
        ({ label, to, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) => [styles.navLink, isActive ? styles.navLinkActive : ""].join(" ")}
          >
            <Icon />
            {label}
          </NavLink>
        ),
      )}
    </nav>
  );
}
