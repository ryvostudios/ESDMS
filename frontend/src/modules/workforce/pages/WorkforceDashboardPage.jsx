import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { KpiCard } from "../../../shared/components/KpiCard.jsx";
import { BarList } from "../../../shared/components/BarList.jsx";
import { UsersIcon, ClipboardCheckIcon, BellIcon } from "../../../shared/icons.jsx";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { EMPLOYEE_STATUSES, EMPLOYEE_STATUS_TONE } from "../constants.js";
import * as api from "../api.js";
import styles from "./WorkforceDashboardPage.module.css";

export function WorkforceDashboardPage() {
  const { hasPermission } = useAuth();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const requests = [api.listEmployees({ pageSize: 100 })];
    if (hasPermission("leave.approve")) requests.push(api.listPendingLeave());
    if (hasPermission("employee_documents.view") && hasPermission("workforce.reports.view")) {
      requests.push(api.listExpiringDocuments(30));
    }
    Promise.all(requests)
      .then(([employees, leave, documents]) =>
        setData({ employees: employees.data, leave: leave?.data || [], documents: documents?.data || [] }),
      )
      .catch((err) => setError(err.message));
  }, [hasPermission]);

  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState message="Loading Workforce overview…" />;

  const total = data.employees.length;
  const statusCounts = EMPLOYEE_STATUSES.reduce((acc, status) => {
    acc[status] = data.employees.filter((row) => row.status === status).length;
    return acc;
  }, {});

  return (
    <div>
      <PageHeader
        title="Workforce Dashboard"
        description="Operational Workforce overview"
        actions={
          <>
            {hasPermission("employees.create") && (
              <Button variant="secondary" onClick={() => navigate("/workforce/employees/new")}>
                Add Employee
              </Button>
            )}
            <Button onClick={() => navigate("/workforce/employees")}>Employee directory</Button>
          </>
        }
      />

      {total === 0 ? (
        <div className={styles.section}>
          {/* "Add Employee" is already a PageHeader action above — not
              duplicated here. */}
          <EmptyState
            title="No employees yet"
            message="Employees created for your site will appear in this overview."
          />
        </div>
      ) : (
        <>
          <div className={styles.kpiGrid}>
            <KpiCard icon={UsersIcon} label="Employees in scope" value={total} />
            <KpiCard label="Active employees" value={statusCounts.ACTIVE} tone="success" />
            {hasPermission("leave.approve") && (
              <KpiCard
                icon={ClipboardCheckIcon}
                label="Pending leave requests"
                value={data.leave.length}
                tone={data.leave.length > 0 ? "warning" : "neutral"}
                context={data.leave.length > 0 ? "Needs review" : undefined}
              />
            )}
            {hasPermission("employee_documents.view") && hasPermission("workforce.reports.view") && (
              <KpiCard
                icon={BellIcon}
                label="Documents expiring (30d)"
                value={data.documents.length}
                tone={data.documents.length > 0 ? "warning" : "neutral"}
              />
            )}
          </div>

          <div className={styles.grid}>
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Employee status breakdown</h2>
              </div>
              <BarList
                items={EMPLOYEE_STATUSES.map((status) => ({
                  label: formatEnumLabel(status),
                  value: statusCounts[status],
                  tone: EMPLOYEE_STATUS_TONE[status],
                }))}
              />
            </div>

            {(hasPermission("leave.approve") || (hasPermission("employee_documents.view") && hasPermission("workforce.reports.view"))) && (
              <div className={styles.section}>
                <div className={styles.sectionHeader}>
                  <h2 className={styles.sectionTitle}>Needs attention</h2>
                  <Link className={styles.viewAll} to="/workforce/operations">
                    Open Operations
                  </Link>
                </div>
                <ul className={styles.attentionList}>
                  {hasPermission("leave.approve") && (
                    <li>
                      {data.leave.length > 0
                        ? `${data.leave.length} leave request${data.leave.length === 1 ? "" : "s"} awaiting your decision`
                        : "No leave requests awaiting decision"}
                    </li>
                  )}
                  {hasPermission("employee_documents.view") && hasPermission("workforce.reports.view") && (
                    <li>
                      {data.documents.length > 0
                        ? `${data.documents.length} document${data.documents.length === 1 ? "" : "s"} expiring within 30 days`
                        : "No documents expiring within 30 days"}
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>

          {hasPermission("workforce.reports.view") && (
            <p className={styles.footerLink}>
              <Link to="/workforce/reports">Run Workforce reports →</Link>
            </p>
          )}
        </>
      )}
    </div>
  );
}
