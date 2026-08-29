import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { FormField, Input, Select, Textarea } from "../../../shared/components/FormField.jsx";
import { Dialog } from "../../../shared/components/Dialog.jsx";
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

function EditCompanyItemDialog({ row, onClose, onSaved }) {
  const [name, setName] = useState(row.item_name);
  const [description, setDescription] = useState(row.item_description || "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.updateCompanyItem(row.company_item_id, { name, description: description || null });
      await onSaved();
      onClose();
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "Unable to update this Company Item."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Edit Company Item" labelledBy="edit-company-item-title">
      <form onSubmit={save}>
        <FormField label="Material name" htmlFor="company-item-name" required>
          <Input id="company-item-name" value={name} maxLength={150} onChange={(event) => setName(event.target.value)} required />
        </FormField>
        <FormField label="Description" htmlFor="company-item-description">
          <Textarea id="company-item-description" value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} />
        </FormField>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" loading={saving}>Save Company Item</Button>{" "}
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
      </form>
    </Dialog>
  );
}

function EditCatalogEntryDialog({ row, unitsOfMeasure, onClose, onSaved }) {
  const [defaultUomId, setDefaultUomId] = useState(row.default_uom_id || "");
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await api.updateCatalogEntry(row.id, { defaultUomId });
      await onSaved();
      onClose();
    } catch (saveError) {
      setError(apiErrorMessage(saveError, "Unable to update the catalog entry."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onClose={onClose} title="Edit Catalog Entry" labelledBy="edit-catalog-entry-title">
      <form onSubmit={save}>
        <FormField label="Default unit" htmlFor="edit-catalog-uom" required>
          <Select id="edit-catalog-uom" value={defaultUomId} onChange={(event) => setDefaultUomId(event.target.value)} required>
            <option value="">Select a unit…</option>
            {unitsOfMeasure.map((uom) => <option key={uom.id} value={uom.id}>{uom.name}</option>)}
          </Select>
        </FormField>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" loading={saving} disabled={!defaultUomId}>Save Catalog Entry</Button>{" "}
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
      </form>
    </Dialog>
  );
}

export function MaterialCatalogPage() {
  const { user, hasPermission } = useAuth();
  const canManage = hasPermission("material_catalog.manage");
  const canSeeAllDepartments = hasPermission("material_catalog.all_departments");
  const canManageCompanyItems = canManage && canSeeAllDepartments;

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
  const [pendingCatalogAction, setPendingCatalogAction] = useState(null);
  const [pendingCompanyItemAction, setPendingCompanyItemAction] = useState(null);
  const [editingCompanyItem, setEditingCompanyItem] = useState(null);
  const [editingCatalogEntry, setEditingCatalogEntry] = useState(null);
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
      setActionError(apiErrorMessage(err, isActive ? "Unable to restore this material to the catalog." : "Unable to remove this material from the catalog."));
    }
  }

  async function confirmCatalogAction() {
    const action = pendingCatalogAction;
    setPendingCatalogAction(null);
    if (action) await setActive(action.row, action.isActive);
  }

  async function confirmCompanyItemAction() {
    const action = pendingCompanyItemAction;
    setPendingCompanyItemAction(null);
    if (!action) return;
    setActionError(null);
    try {
      await api.updateCompanyItem(action.row.company_item_id, { isActive: action.isActive });
      load();
    } catch (err) {
      setActionError(apiErrorMessage(err, action.isActive ? "Unable to reactivate this Company Item." : "Unable to archive this Company Item."));
    }
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
        description={canSeeAllDepartments
          ? "Reusable material catalogs across departments, used to build Demand Lists quickly."
          : "Your department's reusable material list, used to build Demand Lists quickly."}
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
                      <Button variant="ghost" onClick={() => setEditingCatalogEntry(row)}>Edit Catalog</Button>
                      <Button
                        variant="ghost"
                        onClick={() => setPendingCatalogAction({ row, isActive: !row.is_active })}
                      >
                        {row.is_active ? "Remove from Catalog" : "Restore to Catalog"}
                      </Button>
                      {canManageCompanyItems && (
                        <>
                          <Button variant="ghost" onClick={() => setEditingCompanyItem(row)}>Edit Item</Button>
                          <Button
                            variant="ghost"
                            onClick={() => setPendingCompanyItemAction({ row, isActive: !row.company_item_is_active })}
                          >
                            {row.company_item_is_active ? "Archive Company Item" : "Reactivate Company Item"}
                          </Button>
                        </>
                      )}
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
                  <>
                    <Button variant="ghost" onClick={() => setEditingCatalogEntry(row)}>Edit Catalog</Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPendingCatalogAction({ row, isActive: !row.is_active })}
                    >
                      {row.is_active ? "Remove from Catalog" : "Restore to Catalog"}
                    </Button>
                    {canManageCompanyItems && (
                      <>
                        <Button variant="ghost" onClick={() => setEditingCompanyItem(row)}>Edit Item</Button>
                        <Button variant="ghost" onClick={() => setPendingCompanyItemAction({ row, isActive: !row.company_item_is_active })}>
                          {row.company_item_is_active ? "Archive Company Item" : "Reactivate Company Item"}
                        </Button>
                      </>
                    )}
                  </>
                )}
              </li>
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}

      {pendingCatalogAction && (
        <ConfirmActionDialog
          open
          onClose={() => setPendingCatalogAction(null)}
          title={pendingCatalogAction.isActive ? "Restore to Catalog" : "Remove from Catalog"}
          message={pendingCatalogAction.isActive
            ? `Restore “${pendingCatalogAction.row.item_name}” to this department's catalog? It will be available for new Demand selections again.`
            : "This removes the material from new selections for this department. Historical Demands and records will not be changed."}
          confirmLabel={pendingCatalogAction.isActive ? "Restore to Catalog" : "Remove from Catalog"}
          variant={pendingCatalogAction.isActive ? "primary" : "danger"}
          onConfirm={confirmCatalogAction}
        />
      )}

      {pendingCompanyItemAction && (
        <ConfirmActionDialog
          open
          onClose={() => setPendingCompanyItemAction(null)}
          title={pendingCompanyItemAction.isActive ? "Reactivate Company Item" : "Archive Company Item"}
          message={pendingCompanyItemAction.isActive
            ? "Reactivate this global Company Item? Department catalog relationships remain unchanged and must be restored separately."
            : "Archive this global Company Item? It must first be removed from every department catalog. Historical Demand snapshots will not change."}
          confirmLabel={pendingCompanyItemAction.isActive ? "Reactivate Company Item" : "Archive Company Item"}
          variant={pendingCompanyItemAction.isActive ? "primary" : "danger"}
          onConfirm={confirmCompanyItemAction}
        />
      )}

      {editingCompanyItem && (
        <EditCompanyItemDialog row={editingCompanyItem} onClose={() => setEditingCompanyItem(null)} onSaved={load} />
      )}

      {editingCatalogEntry && (
        <EditCatalogEntryDialog
          row={editingCatalogEntry}
          unitsOfMeasure={unitsOfMeasure}
          onClose={() => setEditingCatalogEntry(null)}
          onSaved={load}
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
