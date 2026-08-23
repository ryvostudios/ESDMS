import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import * as api from "../api.js";

export function WorkforceDashboardPage() {
  const { hasPermission } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    const requests = [api.listEmployees({ pageSize: 100 })];
    if (hasPermission("leave.approve")) requests.push(api.listPendingLeave());
    if (hasPermission("employee_documents.view") && hasPermission("workforce.reports.view")) requests.push(api.listExpiringDocuments(30));
    Promise.all(requests).then(([employees, leave, documents]) => setData({ employees: employees.data, leave: leave?.data || [], documents: documents?.data || [] })).catch((err) => setError(err.message));
  }, [hasPermission]);
  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState />;
  const active = data.employees.filter((row) => row.status === "ACTIVE").length;
  return <div>
    <PageHeader title="Workforce Dashboard" description="Operational Workforce overview" />
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 16 }}>
      <section><h2>{data.employees.length}</h2><p>Employees in scope</p></section>
      <section><h2>{active}</h2><p>Active employees</p></section>
      <section><h2>{data.leave.length}</h2><p>Pending leave requests</p></section>
      <section><h2>{data.documents.length}</h2><p>Documents expiring in 30 days</p></section>
    </div>
    <p><Link to="/workforce/employees">Open employee directory</Link></p>
    {hasPermission("workforce.reports.view") && <p><Link to="/workforce/reports">Run Workforce reports</Link></p>}
  </div>;
}
