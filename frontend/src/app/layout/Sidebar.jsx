import { NavList } from "./NavList.jsx";
import styles from "./Sidebar.module.css";

export function Sidebar() {
  return (
    <aside className={styles.sidebar}>
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
