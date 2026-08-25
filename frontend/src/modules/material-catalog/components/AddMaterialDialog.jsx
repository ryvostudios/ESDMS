import { useEffect, useState } from "react";
import { Dialog } from "../../../shared/components/Dialog.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { Input, Select } from "../../../shared/components/FormField.jsx";
import { ApiError } from "../../../core/api/client.js";
import * as api from "../api.js";
import styles from "./AddMaterialDialog.module.css";

const SEARCH_DEBOUNCE_MS = 300;

// Two steps in one dialog rather than a wizard/route: (1) search + pick an
// existing Company Item or choose to create a new one, (2) set the
// department's default unit and confirm. Keeps "add a commonly required
// material" a single, fast flow instead of a separate administration page
// (see docs/PROCUREMENT_RECEIVING_SPEC.md §4).
export function AddMaterialDialog({ open, onClose, onAdded, departmentId, unitsOfMeasure }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [candidate, setCandidate] = useState(null); // { type: "existing", id, name } | { type: "new", name }
  const [defaultUomId, setDefaultUomId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      setResults([]);
      setCandidate(null);
      setDefaultUomId("");
      setError(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open || candidate || !query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return undefined;
    }

    setSearching(true);
    const timer = setTimeout(() => {
      api
        .searchCompanyItems(query.trim(), departmentId)
        .then((response) => setResults(response.data))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [open, query, candidate, departmentId]);

  async function handleConfirm() {
    setSubmitting(true);
    setError(null);

    try {
      const body =
        candidate.type === "existing"
          ? { companyItemId: candidate.id, defaultUomId }
          : { newItem: { name: candidate.name }, defaultUomId };

      const response = await api.addCatalogEntry(body);
      onAdded(response.data);
      onClose();
    } catch (submitError) {
      setError(submitError instanceof ApiError ? submitError.message : "Unable to add this material.");
    } finally {
      setSubmitting(false);
    }
  }

  const trimmedQuery = query.trim();
  const exactMatch = results.some((row) => row.name.toLowerCase() === trimmedQuery.toLowerCase());

  return (
    <Dialog open={open} onClose={onClose} title="Add Material" labelledBy="add-material-title">
      {!candidate && (
        <>
          <Input
            autoFocus
            placeholder="Search materials…"
            aria-label="Search materials"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />

          {searching && <p className={styles.hint}>Searching…</p>}

          {results.length > 0 && (
            <ul className={styles.resultList}>
              {results.map((row) => (
                <li key={row.id} className={styles.resultRow}>
                  <span className={styles.resultName}>{row.name}</span>
                  {row.in_department_catalog ? (
                    <span className={styles.badge}>Already in catalog</span>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => setCandidate({ type: "existing", id: row.id, name: row.name })}
                    >
                      Add
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {trimmedQuery && !searching && !exactMatch && (
            <Button variant="ghost" onClick={() => setCandidate({ type: "new", name: trimmedQuery })}>
              + Create &ldquo;{trimmedQuery}&rdquo; as a new material
            </Button>
          )}
        </>
      )}

      {candidate && (
        <>
          <p className={styles.hint}>
            {candidate.type === "new" ? "New material: " : "Add to your catalog: "}
            <strong>{candidate.name}</strong>
          </p>

          <label className={styles.label} htmlFor="add-material-uom">
            Default unit
          </label>
          <Select
            id="add-material-uom"
            value={defaultUomId}
            onChange={(event) => setDefaultUomId(event.target.value)}
          >
            <option value="">Select a unit…</option>
            {unitsOfMeasure.map((uom) => (
              <option key={uom.id} value={uom.id}>
                {uom.name}
              </option>
            ))}
          </Select>

          {error && (
            <p className={styles.errorMessage} role="alert">
              {error}
            </p>
          )}

          <div className={styles.actions}>
            <Button variant="secondary" onClick={() => setCandidate(null)} disabled={submitting}>
              Back
            </Button>
            <Button onClick={handleConfirm} loading={submitting} disabled={!defaultUomId}>
              Add Material
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
