import { useEffect, useState, useCallback, useMemo } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { EMPLOYEE_STATUS_TONE } from "../constants.js";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import * as api from "../api.js";
import styles from "./EmployeesListPage.module.css";

export function EmployeesListPage() {
  const { hasPermission } = useAuth();
  const [rows, setRows] = useState([]);
  const [sites, setSites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [siteId, setSiteId] = useState("");

  // Sites list is used only to resolve a human-readable Site column/filter
  // — the same existing endpoint already used by Add Employee/Transfer.
  useEffect(() => {
    api
      .listSites()
      .then((r) => setSites(r.data))
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listEmployees({
        pageSize: 100,
        ...(search && { search }),
        ...(status && { status }),
        ...(siteId && { siteId }),
      });
      setRows(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load employees.");
    } finally {
      setLoading(false);
    }
  }, [search, status, siteId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const siteNameById = useMemo(() => new Map(sites.map((s) => [s.id, s.name])), [sites]);
  const hasActiveFilter = Boolean(search || status || siteId);

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
            {hasPermission("workforce.export") && (
              <Button variant="secondary" onClick={downloadReport}>
                Export Excel
              </Button>
            )}
            {hasPermission("employees.create") && (
              <Link to="/workforce/employees/new">
                <Button>Add Employee</Button>
              </Link>
            )}
          </>
        }
      />

      <div className={styles.filters}>
        <SearchField
          ariaLabel="Search employees"
          placeholder="Search name or Employee ID"
          value={search}
          onChange={setSearch}
        />
        <Select
          className={styles.filterSelect}
          aria-label="Employment status"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">All statuses</option>
          <option>ACTIVE</option>
          <option>INACTIVE</option>
          <option>RESIGNED</option>
          <option>TERMINATED</option>
        </Select>
        {sites.length > 1 && (
          <Select
            className={styles.filterSelect}
            aria-label="Site"
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
          >
            <option value="">All sites</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
      </div>

      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && rows.length === 0 && (
        // "Add Employee" is already a PageHeader action above — not
        // duplicated here.
        <EmptyState
          title={hasActiveFilter ? "No employees match these filters" : "No employees yet"}
          message={hasActiveFilter ? "Try a different search term or clear the filters." : undefined}
        />
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Position</th>
                <th>Department</th>
                <th>Site</th>
                <th>Status</th>
                <th className={styles.actionHeader} aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <Link to={`/workforce/employees/${row.id}`} className={styles.identity}>
                      <span className={styles.name}>{row.fullLegalName}</span>
                      <span className={styles.code}>
                        {row.employeeCode}
                        {!row.hasLogin && " · no login"}
                      </span>
                    </Link>
                  </td>
                  <td>{row.positionName || "—"}</td>
                  <td>{row.departmentName || "—"}</td>
                  <td>{siteNameById.get(row.primarySiteId) || "—"}</td>
                  <td>
                    <StatusBadge tone={EMPLOYEE_STATUS_TONE[row.status] || "neutral"} label={formatEnumLabel(row.status)} />
                  </td>
                  <td className={styles.actionCell}>
                    <Link to={`/workforce/employees/${row.id}`} className={styles.viewLink}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className={styles.cardList}>
            {rows.map((row) => (
              <li key={row.id}>
                <Link to={`/workforce/employees/${row.id}`} className={styles.card}>
                  <div className={styles.cardHeader}>
                    <span className={styles.name}>{row.fullLegalName}</span>
                    <StatusBadge tone={EMPLOYEE_STATUS_TONE[row.status] || "neutral"} label={formatEnumLabel(row.status)} />
                  </div>
                  <span className={styles.code}>
                    {row.employeeCode}
                    {!row.hasLogin && " · no login"}
                  </span>
                  <div className={styles.cardMeta}>
                    <span>{row.positionName || "No position"}</span>
                    <span>{row.departmentName || "No department"}</span>
                    <span>{siteNameById.get(row.primarySiteId) || "No site"}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
