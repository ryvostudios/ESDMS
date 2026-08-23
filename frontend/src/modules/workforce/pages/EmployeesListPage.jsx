import { useEffect, useState, useCallback } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { Input, Select } from "../../../shared/components/FormField.jsx";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import * as api from "../api.js";

export function EmployeesListPage() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listEmployees({ pageSize: 100, ...(search && { search }), ...(status && { status }) });
      setRows(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load employees.");
    } finally {
      setLoading(false);
    }
  }, [search, status]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function downloadReport() {
    const blob = await api.downloadEmployeeMasterReport();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "Employee_Master.xlsx";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <PageHeader
        title="Employees"
        actions={
          <>
            {hasPermission("workforce.export") && <Button variant="secondary" onClick={downloadReport}>
              Export Excel
            </Button>}
            {hasPermission("employees.create") && <Link to="/workforce/employees/new">
              <Button>Add Employee</Button>
            </Link>}
          </>
        }
      />
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}><Input aria-label="Search employees" placeholder="Search name or Employee ID" value={search} onChange={(e) => setSearch(e.target.value)} /><Select aria-label="Employment status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option><option>ACTIVE</option><option>INACTIVE</option><option>RESIGNED</option><option>TERMINATED</option></Select></div>
      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={load} />}
      {!loading && !error && rows.length === 0 && <EmptyState title="No employees yet" />}
      {!loading &&
        !error &&
        rows.map((row) => (
          <p key={row.id}>
            <Link to={`/workforce/employees/${row.id}`}>
              {row.employeeCode} — {row.fullLegalName}
            </Link>{" "}
            ({row.status}) {row.departmentName ? `· ${row.departmentName}` : ""} {row.hasLogin ? "" : "· no login"}
          </p>
        ))}
    </div>
  );
}
