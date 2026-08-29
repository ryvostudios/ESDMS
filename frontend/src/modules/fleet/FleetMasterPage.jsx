import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../shared/components/PageHeader.jsx";
import { Button } from "../../shared/components/Button.jsx";
import { SearchField } from "../../shared/components/SearchField.jsx";
import { FormField, Input, Select, Textarea } from "../../shared/components/FormField.jsx";
import { Dialog } from "../../shared/components/Dialog.jsx";
import { StatusBadge } from "../../shared/components/StatusBadge.jsx";
import { ConfirmActionDialog } from "../../shared/components/ConfirmActionDialog.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../shared/components/StatePanel.jsx";
import { useAuth } from "../../core/auth/AuthContext.jsx";
import { apiErrorMessage } from "../../shared/utilities/api-error-message.js";
import { DRIVER_CONFIG, VEHICLE_CONFIG } from "./fleet-configs.js";

// One page component drives both Driver and Vehicle. They are the same
// screen — a searchable site-scoped master list with add/edit and a
// confirmed deactivate/reactivate — so a `config` object describes the
// fields rather than duplicating the whole screen twice.

function initialValues(config, row) {
  return Object.fromEntries(
    config.fields.map((field) => [field.name, (row ? row[field.column || field.name] : "") ?? ""]),
  );
}

function FleetDialog({ config, row, onClose, onSaved }) {
  const [values, setValues] = useState(() => initialValues(config, row));
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(event) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    // Blank optional inputs are sent as null (clear the field), never as ""
    // — the API treats an empty string as a value, so "" would store an
    // empty CNIC rather than no CNIC.
    const body = Object.fromEntries(
      config.fields
        .filter((field) => field.required || values[field.name] !== "" || row)
        .map((field) => [field.name, values[field.name] === "" ? null : values[field.name]]),
    );

    try {
      if (row) await config.update(row.id, body);
      else await config.create(body);
      await onSaved();
      onClose();
    } catch (saveError) {
      setError(apiErrorMessage(saveError, `Unable to save this ${config.key}.`));
    } finally {
      setSaving(false);
    }
  }

  const title = `${row ? "Edit" : "Add"} ${config.key === "driver" ? "Driver" : "Vehicle"}`;

  return (
    <Dialog open onClose={onClose} title={title} labelledBy="fleet-dialog-title">
      <form onSubmit={save}>
        {config.fields.map((field) => (
          <FormField key={field.name} label={field.label} htmlFor={`fleet-${field.name}`} required={field.required}>
            {field.type === "select" ? (
              <Select
                id={`fleet-${field.name}`}
                value={values[field.name] || field.options[0]}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              >
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </Select>
            ) : field.type === "textarea" ? (
              <Textarea
                id={`fleet-${field.name}`}
                value={values[field.name]}
                maxLength={field.maxLength}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              />
            ) : (
              <Input
                id={`fleet-${field.name}`}
                type={field.type || "text"}
                value={values[field.name]}
                maxLength={field.maxLength}
                required={field.required}
                onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
              />
            )}
          </FormField>
        ))}
        {error && <p role="alert">{error}</p>}
        <Button type="submit" loading={saving}>
          Save
        </Button>{" "}
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
      </form>
    </Dialog>
  );
}

export function FleetMasterPage({ config }) {
  const { hasPermission } = useAuth();
  const canManage = hasPermission(config.managePermission);

  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState(null);
  const [adding, setAdding] = useState(false);
  const [pendingLifecycle, setPendingLifecycle] = useState(null);
  const [actionError, setActionError] = useState(null);

  const load = useCallback(async () => {
    setStatus("loading");
    try {
      const response = await config.list({
        search: search || undefined,
        includeInactive: includeInactive ? "true" : undefined,
      });
      setRows(response.data);
      setStatus("ready");
    } catch (loadError) {
      setError(apiErrorMessage(loadError, `Unable to load ${config.title.toLowerCase()}.`));
      setStatus("error");
    }
  }, [config, search, includeInactive]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function confirmLifecycle() {
    const action = pendingLifecycle;
    setPendingLifecycle(null);
    if (!action) return;
    setActionError(null);
    try {
      await config.update(action.row.id, { isActive: action.isActive });
      load();
    } catch (updateError) {
      setActionError(apiErrorMessage(updateError, "Unable to update this record."));
    }
  }

  return (
    <div>
      <PageHeader
        title={config.title}
        description={config.subtitle}
        actions={canManage ? <Button onClick={() => setAdding(true)}>Add {config.key === "driver" ? "Driver" : "Vehicle"}</Button> : null}
      />

      <SearchField value={search} onChange={setSearch} placeholder={`Search ${config.title.toLowerCase()}…`} />
      <label>
        <input
          type="checkbox"
          checked={includeInactive}
          onChange={(event) => setIncludeInactive(event.target.checked)}
        />{" "}
        Show inactive
      </label>

      {actionError && <p role="alert">{actionError}</p>}

      {status === "loading" && <LoadingState />}
      {status === "error" && <ErrorState message={error} onRetry={load} />}
      {status === "ready" && rows.length === 0 && <EmptyState title="Nothing yet" />}

      {status === "ready" && rows.length > 0 && (
        <table>
          <thead>
            <tr>
              {config.columns.map((column) => (
                <th key={column.header}>{column.header}</th>
              ))}
              <th>Status</th>
              {canManage && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                {config.columns.map((column) => (
                  <td key={column.header}>{column.render(row)}</td>
                ))}
                <td>
                  <StatusBadge tone={row.is_active ? "success" : "neutral"} label={row.is_active ? "Active" : "Inactive"} />
                </td>
                {canManage && (
                  <td>
                    <Button variant="ghost" onClick={() => setEditing(row)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => setPendingLifecycle({ row, isActive: !row.is_active })}
                    >
                      {row.is_active ? "Deactivate" : "Reactivate"}
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {(adding || editing) && (
        <FleetDialog
          config={config}
          row={editing}
          onClose={() => {
            setAdding(false);
            setEditing(null);
          }}
          onSaved={load}
        />
      )}

      {pendingLifecycle && (
        <ConfirmActionDialog
          open
          onClose={() => setPendingLifecycle(null)}
          title={pendingLifecycle.isActive ? "Reactivate" : "Deactivate"}
          message={
            pendingLifecycle.isActive
              ? `Reactivate “${config.label(pendingLifecycle.row)}”? It becomes selectable on new Gate Passes again.`
              : `Deactivate “${config.label(pendingLifecycle.row)}”? It can no longer be chosen for a new Gate Pass. Existing Gate Pass history is never changed.`
          }
          confirmLabel={pendingLifecycle.isActive ? "Reactivate" : "Deactivate"}
          variant={pendingLifecycle.isActive ? "primary" : "danger"}
          onConfirm={confirmLifecycle}
        />
      )}
    </div>
  );
}

export const DriversPage = () => <FleetMasterPage config={DRIVER_CONFIG} />;
export const VehiclesPage = () => <FleetMasterPage config={VEHICLE_CONFIG} />;
