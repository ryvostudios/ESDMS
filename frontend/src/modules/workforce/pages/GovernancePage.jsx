import { useEffect, useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { ErrorState, LoadingState } from "../../../shared/components/StatePanel.jsx";
import * as api from "../api.js";

export function GovernancePage() {
  const { user: actor, hasPermission } = useAuth();
  const [users, setUsers] = useState(null);
  const [selected, setSelected] = useState(null);
  const [overview, setOverview] = useState(null);
  const [permissionCode, setPermissionCode] = useState("");
  const [effect, setEffect] = useState("DENY");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const load = () => api.listUsers().then((r) => setUsers(r.data)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  async function selectUser(user) { setSelected(user); setOverview(null); try { setOverview((await api.getUserPermissions(user.id)).data); } catch (e) { setError(e.message); } }
  async function saveOverride(event) { event.preventDefault(); try { await api.setUserPermission(selected.id, permissionCode, { effect, reason }); await selectUser(selected); setPermissionCode(""); } catch (e) { setError(e.message); } }
  async function remove(code) { try { await api.removeUserPermission(selected.id, code); await selectUser(selected); } catch (e) { setError(e.message); } }
  async function active(value) { try { await (value ? api.activateUser(selected.id) : api.deactivateUser(selected.id)); setSelected((current) => ({ ...current, isActive: value })); await load(); } catch (e) { setError(e.message); } }
  if (error && !users) return <ErrorState message={error} onRetry={load} />;
  if (!users) return <LoadingState />;
  const canTargetSelected = selected && selected.role !== "CEO" && selected.id !== actor.id
    && (selected.role !== "UPPER_MANAGEMENT" || hasPermission("users.manage_um"));
  const canToggleSelected = canTargetSelected && hasPermission(selected.isActive ? "users.deactivate" : "users.activate");
  return <div><PageHeader title="User Governance" description="Effective permissions and individual GRANT / DENY controls" />
    {error && <p role="alert">{error}</p>}
    <div style={{ display: "grid", gridTemplateColumns: "minmax(220px,1fr) minmax(300px,2fr)", gap: 24 }}>
      <section><h2>Users</h2>{users.map((user) => <p key={user.id}><Button variant="secondary" onClick={() => selectUser(user)}>{user.fullName} · {user.role} {user.isActive ? "" : "(inactive)"}</Button></p>)}</section>
      <section><h2>{selected ? selected.fullName : "Select a user"}</h2>
        {canToggleSelected && <p><Button variant="secondary" onClick={() => active(!selected.isActive)}>{selected.isActive ? "Deactivate" : "Activate"}</Button></p>}
        {canTargetSelected && hasPermission("users.update") && <FormField label="Role" htmlFor="governanceRole"><Select id="governanceRole" value={selected.role} onChange={async (e) => { try { const role = e.target.value; await api.changeUserRole(selected.id, role); setSelected((current) => ({ ...current, role })); await load(); } catch (err) { setError(err.message); } }}><option>EMPLOYEE</option><option>HR</option>{hasPermission("users.manage_um") && <option>UPPER_MANAGEMENT</option>}<option>ADMIN</option><option>SITE_MANAGER</option><option>TEAM_LEAD</option><option>GATE_GUARD</option></Select></FormField>}
        {selected && !overview && <LoadingState />}
        {overview && <><h3>Effective permissions</h3><p>{overview.effectivePermissions.length ? overview.effectivePermissions.join(", ") : "None"}</p><h3>Overrides</h3>{overview.overrides.map((item) => <p key={item.permissionCode}>{item.permissionCode}: {item.effect} {canTargetSelected && hasPermission("permission_overrides.manage") && <Button variant="secondary" onClick={() => remove(item.permissionCode)}>Remove</Button>}</p>)}
        {canTargetSelected && hasPermission("permission_overrides.manage") && <form onSubmit={saveOverride}><FormField label="Permission code" htmlFor="permissionCode"><Input id="permissionCode" value={permissionCode} onChange={(e) => setPermissionCode(e.target.value)} required /></FormField><FormField label="Effect" htmlFor="effect"><Select id="effect" value={effect} onChange={(e) => setEffect(e.target.value)}><option>DENY</option><option>GRANT</option></Select></FormField><FormField label="Reason" htmlFor="overrideReason"><Input id="overrideReason" value={reason} onChange={(e) => setReason(e.target.value)} /></FormField><Button type="submit">Save override</Button></form>}</>}
      </section>
    </div>
  </div>;
}
