import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ApiError } from "../../../core/api/client.js";
import { listDepartmentsManage } from "../../workforce/api.js";
import { AddMaterialDialog } from "../components/AddMaterialDialog.jsx";
import * as api from "../api.js";
import styles from "./MaterialCatalogPage.module.css";

const PAGE_SIZE = 50;

export function MaterialCatalogPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("material_catalog.manage");
  const canSeeAllDepartments = hasPermission("material_catalog.all_departments");

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [unitsOfMeasure, setUnitsOfMeasure] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [page, setPage] = useState(1);
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  useEffect(() => {
    api
      .listUnitsOfMeasure()
      .then((response) => setUnitsOfMeasure(response.data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!canSeeAllDepartments) return;
    listDepartmentsManage()
      .then((response) => setDepartments(response.data))
      .catch(() => {});
  }, [canSeeAllDepartments]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listCatalog({
        page,
        pageSize: PAGE_SIZE,
        ...(search && { search }),
        ...(departmentId && { departmentId }),
      });
      setRows(response.data);
      setTotal(response.meta.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load the material catalog.");
    } finally {
      setLoading(false);
    }
  }, [search, departmentId, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function toggleActive(row) {
    try {
      await api.updateCatalogEntry(row.id, { isActive: !row.is_active });
      load();
    } catch {
      // The row simply doesn't update; the existing error banner covers a
      // failed initial load, and this is a low-stakes, retryable toggle.
    }
  }

  const hasActiveFilter = Boolean(search || departmentId);
  const targetDepartmentId = departmentId || user.departmentId;

  return (
    <div>
      <PageHeader
        title="Material Catalog"
        description="Your department's reusable material list, used to build Demand Lists quickly."
        actions={
          canManage && (
            <Button onClick={() => setAddDialogOpen(true)} disabled={!targetDepartmentId}>
              Add Material
            </Button>
          )
        }
      />

      <div className={styles.filters}>
        <SearchField
          ariaLabel="Search materials"
          placeholder="Search materials"
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
        />
        {canSeeAllDepartments && departments.length > 0 && (
          <Select
            className={styles.filterSelect}
            aria-label="Department"
            value={departmentId}
            onChange={(event) => {
              setDepartmentId(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
                {department.site_name ? ` — ${department.site_name}` : ""}
              </option>
            ))}
          </Select>
        )}
      </div>

      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && rows.length === 0 && (
        <EmptyState
          title={hasActiveFilter ? "No materials match these filters" : "No materials in this catalog yet"}
          message={
            hasActiveFilter
              ? "Try a different search term or clear the filters."
              : canManage
                ? "Add your first material to get started."
                : undefined
          }
        />
      )}

      {!loading && !error && rows.length > 0 && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Material</th>
                {canSeeAllDepartments && <th>Department</th>}
                <th>Default unit</th>
                <th>Status</th>
                {canManage && <th className={styles.actionHeader} aria-hidden="true" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>
                    <span className={styles.name}>{row.item_name}</span>
                  </td>
                  {canSeeAllDepartments && <td>{row.department_name}</td>}
                  <td>{row.default_uom_name}</td>
                  <td>
                    <StatusBadge tone={row.is_active ? "success" : "neutral"} label={row.is_active ? "Active" : "Archived"} />
                  </td>
                  {canManage && (
                    <td className={styles.actionCell}>
                      <Button variant="ghost" onClick={() => toggleActive(row)}>
                        {row.is_active ? "Archive" : "Restore"}
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          <ul className={styles.cardList}>
            {rows.map((row) => (
              <li key={row.id} className={styles.card}>
                <div className={styles.cardHeader}>
                  <span className={styles.name}>{row.item_name}</span>
                  <StatusBadge tone={row.is_active ? "success" : "neutral"} label={row.is_active ? "Active" : "Archived"} />
                </div>
                <div className={styles.cardMeta}>
                  {canSeeAllDepartments && <span>{row.department_name}</span>}
                  <span>{row.default_uom_name}</span>
                </div>
                {canManage && (
                  <Button variant="ghost" onClick={() => toggleActive(row)}>
                    {row.is_active ? "Archive" : "Restore"}
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      {canManage && (
        <AddMaterialDialog
          open={addDialogOpen}
          onClose={() => setAddDialogOpen(false)}
          onAdded={load}
          departmentId={departmentId || user.departmentId}
          unitsOfMeasure={unitsOfMeasure}
        />
      )}
    </div>
  );
}
