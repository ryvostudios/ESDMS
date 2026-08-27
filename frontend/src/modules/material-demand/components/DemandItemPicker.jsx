import { useCallback, useEffect, useMemo, useState } from "react";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Input } from "../../../shared/components/FormField.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { AddMaterialDialog } from "../../material-catalog/components/AddMaterialDialog.jsx";
import * as catalogApi from "../../material-catalog/api.js";
import { ApiError } from "../../../core/api/client.js";
import styles from "./DemandItemPicker.module.css";

// Controlled: `selections` is a plain { [catalogEntryId]: quantityString }
// map owned by the parent form. Duplicate lines are structurally
// impossible — a checkbox is either present as one key or absent, never
// two rows for the same material (see docs/PROCUREMENT_RECEIVING_SPEC.md
// §6). "Add Material" reuses Checkpoint 1's AddMaterialDialog/service
// directly rather than a second material-creation implementation.
export function DemandItemPicker({ departmentId, selections, onChange, disabled = false }) {
  const [catalog, setCatalog] = useState([]);
  const [unitsOfMeasure, setUnitsOfMeasure] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);

  const load = useCallback(() => {
    if (!departmentId) {
      setCatalog([]);
      setLoading(false);
      return Promise.resolve();
    }

    setLoading(true);
    setError(null);
    return catalogApi
      .listCatalog({ departmentId, pageSize: 200 })
      .then((response) => setCatalog(response.data))
      .catch((err) => setError(err instanceof ApiError ? err.message : "Unable to load the material catalog."))
      .finally(() => setLoading(false));
  }, [departmentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    catalogApi
      .listUnitsOfMeasure()
      .then((response) => setUnitsOfMeasure(response.data))
      .catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return catalog;
    return catalog.filter((row) => row.item_name.toLowerCase().includes(term));
  }, [catalog, search]);

  function toggle(catalogEntryId, checked) {
    const next = { ...selections };
    if (checked) {
      next[catalogEntryId] = selections[catalogEntryId] ?? "1";
    } else {
      delete next[catalogEntryId];
    }
    onChange(next);
  }

  function setQuantity(catalogEntryId, value) {
    onChange({ ...selections, [catalogEntryId]: value });
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <SearchField value={search} onChange={setSearch} placeholder="Search materials…" ariaLabel="Search materials" />
      </div>

      {loading && <LoadingState message="Loading catalog…" />}
      {error && <ErrorState message={error} onRetry={load} />}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          title={catalog.length === 0 ? "No materials in this department's catalog yet" : "No materials match your search"}
        />
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className={styles.list}>
          {filtered.map((row) => {
            const checked = Object.prototype.hasOwnProperty.call(selections, row.id);
            return (
              <li className={styles.row} key={row.id}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled}
                    onChange={(event) => toggle(row.id, event.target.checked)}
                  />
                  {row.item_name}
                </label>
                {checked && (
                  <div className={styles.quantityGroup}>
                    <Input
                      className={styles.quantityInput}
                      type="number"
                      min="0"
                      step="any"
                      value={selections[row.id]}
                      disabled={disabled}
                      onChange={(event) => setQuantity(row.id, event.target.value)}
                      aria-label={`Quantity for ${row.item_name}`}
                    />
                    <span className={styles.uom}>{row.default_uom_name}</span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!disabled && (
        <Button
          type="button"
          variant="secondary"
          onClick={() => setAddDialogOpen(true)}
          disabled={!departmentId}
          title={departmentId ? undefined : "Choose a department first."}
        >
          + Add Material
        </Button>
      )}

      <AddMaterialDialog
        open={addDialogOpen}
        onClose={() => setAddDialogOpen(false)}
        onAdded={(entry) => {
          load();
          onChange({ ...selections, [entry.id]: selections[entry.id] ?? "1" });
        }}
        departmentId={departmentId}
        unitsOfMeasure={unitsOfMeasure}
      />
    </div>
  );
}
