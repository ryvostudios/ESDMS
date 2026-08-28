import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { apiErrorMessage } from "../../../shared/utilities/api-error-message.js";
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
  // The API's includeInactive returns active AND archived rows; "Active" is
  // the default view, "All statuses" is how an archived material is found
  // again so it can be restored. Archiving used to be a one-way trip purely
  // because nothing ever asked for the archived rows.
  const [includeInactive, setIncludeInactive] = useState(false);
  const [pendingArchive, setPendingArchive] = useState(null);
  const [actionError, setActionError] = useState(null);

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
        ...(includeInactive && { includeInactive: "true" }),
      });
      setRows(response.data);
      setTotal(response.meta.total);
    } catch (err) {
      setError(apiErrorMessage(err, "Unable to load the material catalog."));
    } finally {
      setLoading(false);
    }
  }, [search, departmentId, page, includeInactive]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function setActive(row, isActive) {
    setActionError(null);
    try {
      await api.updateCatalogEntry(row.id, { isActive });
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, isActive ? "Unable to restore this material." : "Unable to archive this material."));
    }
  }

  // Archiving removes a material from every new Demand's picker, so it is
  // confirmed. Restoring is not — it only puts a choice back.
  async function confirmArchive() {
    const row = pendingArchive;
    setPendingArchive(null);
    if (row) await setActive(row, false);
  }

  const hasActiveFilter = Boolean(search || departmentId || includeInactive);
  const targetDepartmentId = departmentId || user.departmentId;
  // "All departments" is the default filter for a company-wide actor, and they
  // have no department of their own — so requiring a resolved department here
  // left the button permanently greyed out for them. They can pick the
  // department inside the dialog instead; only an actor with neither a
  // department nor anything to choose from is genuinely unable to add.
  const canAddMaterial = Boolean(targetDepartmentId) || (canSeeAllDepartments && departments.length > 0);

  return (
    <div>
      <PageHeader
        title="Material Catalog"
        description="Your department's reusable material list, used to build Demand Lists quickly."
        actions={
          canManage && (
            <Button
              onClick={() => setAddDialogOpen(true)}
              disabled={!canAddMaterial}
              title={canAddMaterial ? undefined : "You are not assigned to a department."}
            >
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
        <Select
          className={styles.filterSelect}
          aria-label="Status"
          value={includeInactive ? "all" : "active"}
          onChange={(event) => {
            setIncludeInactive(event.target.value === "all");
            setPage(1);
          }}
        >
          <option value="active">Active only</option>
          <option value="all">All statuses</option>
        </Select>
      </div>

      {actionError && <ErrorState message={actionError} />}
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
                      <Button
                        variant="ghost"
                        onClick={() => (row.is_active ? setPendingArchive(row) : setActive(row, true))}
                      >
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
                  <Button
                    variant="ghost"
                    onClick={() => (row.is_active ? setPendingArchive(row) : setActive(row, true))}
                  >
                    {row.is_active ? "Archive" : "Restore"}
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      {pendingArchive && (
        <ConfirmActionDialog
          open
          onClose={() => setPendingArchive(null)}
          title="Archive material"
          message={`Archive “${pendingArchive.item_name}” from the department catalog? It will no longer appear when building a new Demand. Existing Demands keep it, and you can restore it later.`}
          confirmLabel="Archive"
          onConfirm={confirmArchive}
        />
      )}

      {canManage && (
        <AddMaterialDialog
          open={addDialogOpen}
          onClose={() => setAddDialogOpen(false)}
          onAdded={load}
          departmentId={targetDepartmentId || ""}
          departments={departments}
          unitsOfMeasure={unitsOfMeasure}
        />
      )}
    </div>
  );
}
