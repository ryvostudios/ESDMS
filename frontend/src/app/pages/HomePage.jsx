import { useAuth } from "../../core/auth/AuthContext.jsx";
import { formatEnumLabel } from "../../shared/utilities/format.js";
import { PageHeader } from "../../shared/components/PageHeader.jsx";
import styles from "./HomePage.module.css";

export function HomePage() {
  const { user } = useAuth();

  return (
    <div>
      <PageHeader title={`Welcome, ${user.fullName.split(" ")[0]}`} description="E-Set Digital Management System" />
      <section className={styles.card}>
        <dl className={styles.detailList}>
          <div className={styles.detailRow}>
            <dt>Role</dt>
            <dd>{formatEnumLabel(user.role)}</dd>
          </div>
          <div className={styles.detailRow}>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
