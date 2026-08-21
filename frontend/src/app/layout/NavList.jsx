import { NavLink } from "react-router-dom";
import { NAV_ITEMS } from "./navigation.js";
import styles from "./Sidebar.module.css";

export function NavList({ onNavigate }) {
  return (
    <nav className={styles.nav} aria-label="Primary">
      {NAV_ITEMS.map(({ label, to, icon: Icon, end }) => (
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
      ))}
    </nav>
  );
}
