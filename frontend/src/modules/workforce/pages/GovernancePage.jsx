import { useEffect, useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { ErrorState, LoadingState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { KpiCard } from "../../../shared/components/KpiCard.jsx";
import { UsersIcon } from "../../../shared/icons.jsx";
import styles from "./GovernancePage.module.css";
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
  const [regenOpen, setRegenOpen] = useState(false);
  const [tempPassword, setTempPassword] = useState(null);
  const [deactivateOpen, setDeactivateOpen] = useState(false);

  const load = () =>
    api
      .listUsers()
      .then((r) => setUsers(r.data))
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);

  async function selectUser(user) {
    setSelected(user);
    setOverview(null);
    setTempPassword(null);
    try {
      setOverview((await api.getUserPermissions(user.id)).data);
    } catch (e) {
      setError(e.message);
    }
  }

  async function regenerateTempPassword() {
    const result = await api.regenerateTempPassword(selected.id);
    setTempPassword(result.data.temporaryPassword);
  }

  async function saveOverride(event) {
    event.preventDefault();
    try {
      await api.setUserPermission(selected.id, permissionCode, { effect, reason });
      await selectUser(selected);
      setPermissionCode("");
    } catch (e) {
      setError(e.message);
    }
  }

  async function remove(code) {
    try {
      await api.removeUserPermission(selected.id, code);
      await selectUser(selected);
    } catch (e) {
      setError(e.message);
    }
  }

  async function setActive(value) {
    try {
      await (value ? api.activateUser(selected.id) : api.deactivateUser(selected.id));
      setSelected((current) => ({ ...current, isActive: value }));
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  if (error && !users) return <ErrorState message={error} onRetry={load} />;
  if (!users) return <LoadingState />;

  const canTargetSelected =
    selected &&
    selected.role !== "CEO" &&
    selected.id !== actor.id &&
    (selected.role !== "UPPER_MANAGEMENT" || hasPermission("users.manage_um"));
  const canToggleSelected = canTargetSelected && hasPermission(selected.isActive ? "users.deactivate" : "users.activate");
  const activeCount = users.filter((u) => u.isActive).length;

  // A permission with an active GRANT override is called out — everything
  // else in the effective set came from the role baseline. DENY overrides
  // never appear here at all (they're already excluded from the effective
  // set); they're still visible, distinctly, in the overrides list below.
  const grantedCodes = new Set((overview?.overrides || []).filter((o) => o.effect === "GRANT").map((o) => o.permissionCode));

  return (
    <div>
      <PageHeader title="User Governance" description="Account authority, roles, and individual permission overrides." />
      {error && <p role="alert">{error}</p>}

      <div className={styles.kpiGrid}>
        <KpiCard icon={UsersIcon} label="Users in scope" value={users.length} />
        <KpiCard label="Active" value={activeCount} tone="success" />
        <KpiCard label="Inactive" value={users.length - activeCount} tone={users.length - activeCount > 0 ? "warning" : "neutral"} />
      </div>

      <div className={styles.layout}>
        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>Users</h2>

          <table className={styles.table}>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className={[styles.userRow, selected?.id === user.id ? styles.userRowSelected : ""].filter(Boolean).join(" ")}
                  onClick={() => selectUser(user)}
                >
                  <td>
                    <span className={styles.userIdentity}>
                      <span className={styles.userName}>{user.fullName}</span>
                      <span className={styles.userEmail}>{user.email}</span>
                    </span>
                  </td>
                  <td>{user.role}</td>
                  <td>
                    <StatusBadge tone={user.isActive ? "success" : "neutral"} label={user.isActive ? "Active" : "Inactive"} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className={styles.cardList}>
            {users.map((user) => (
              <li key={user.id}>
                <button
                  type="button"
                  className={[styles.userCard, selected?.id === user.id ? styles.userCardSelected : ""].filter(Boolean).join(" ")}
                  onClick={() => selectUser(user)}
                >
                  <span className={styles.userCardTop}>
                    <span className={styles.userName}>{user.fullName}</span>
                    <StatusBadge tone={user.isActive ? "success" : "neutral"} label={user.isActive ? "Active" : "Inactive"} />
                  </span>
                  <span className={styles.userCardMeta}>
                    <span>{user.email}</span>
                    <span>{user.role}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section}>
          {!selected && <p className={styles.emptySelection}>Select a user to view and manage their authority.</p>}

          {selected && (
            <>
              <div className={styles.selectedHeader}>
                <h2 className={styles.selectedName}>{selected.fullName}</h2>
                <span className={styles.selectedMeta}>{selected.role}</span>
                <StatusBadge tone={selected.isActive ? "success" : "neutral"} label={selected.isActive ? "Active" : "Inactive"} />
              </div>

              {canTargetSelected && hasPermission("users.update") && (
                <div className={styles.actionGroup}>
                  <h3 className={styles.actionGroupTitle}>Routine governance</h3>
                  <div className={styles.actionRow}>
                    <FormField label="Role" htmlFor="governanceRole">
                      <Select
                        id="governanceRole"
                        value={selected.role}
                        onChange={async (e) => {
                          try {
                            const role = e.target.value;
                            await api.changeUserRole(selected.id, role);
                            setSelected((current) => ({ ...current, role }));
                            await load();
                          } catch (err) {
                            setError(err.message);
                          }
                        }}
                      >
                        <option>EMPLOYEE</option>
                        <option>HR</option>
                        {hasPermission("users.manage_um") && <option>UPPER_MANAGEMENT</option>}
                        <option>ADMIN</option>
                        <option>SITE_MANAGER</option>
                        <option>TEAM_LEAD</option>
                        <option>GATE_GUARD</option>
                      </Select>
                    </FormField>
                  </div>
                </div>
              )}

              {selected && !overview && <LoadingState />}

              {overview && (
                <div className={styles.actionGroup}>
                  <h3 className={styles.actionGroupTitle}>Permission overrides</h3>

                  <p className={styles.detailLabel}>Effective permissions</p>
                  <div className={styles.chipList}>
                    {overview.effectivePermissions.length === 0 && <span className={styles.emptySelection}>None</span>}
                    {overview.effectivePermissions.map((code) => (
                      <span key={code} className={[styles.chip, grantedCodes.has(code) ? styles.chipGranted : ""].filter(Boolean).join(" ")}>
                        {code}
                        {grantedCodes.has(code) && " · granted"}
                      </span>
                    ))}
                  </div>

                  <p className={styles.detailLabel}>Individual overrides</p>
                  {overview.overrides.length === 0 && <p className={styles.emptySelection}>No individual overrides.</p>}
                  <ul className={styles.overrideList}>
                    {overview.overrides.map((item) => (
                      <li key={item.permissionCode} className={styles.overrideRow}>
                        <span className={styles.overrideCode}>{item.permissionCode}</span>
                        <StatusBadge tone={item.effect === "GRANT" ? "success" : "danger"} label={item.effect} />
                        {canTargetSelected && hasPermission("permission_overrides.manage") && (
                          <Button variant="secondary" onClick={() => remove(item.permissionCode)}>
                            Remove
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>

                  {canTargetSelected && hasPermission("permission_overrides.manage") && (
                    <form onSubmit={saveOverride} className={styles.actionRow}>
                      <FormField label="Permission code" htmlFor="permissionCode">
                        <Input id="permissionCode" value={permissionCode} onChange={(e) => setPermissionCode(e.target.value)} required />
                      </FormField>
                      <FormField label="Effect" htmlFor="effect">
                        <Select id="effect" value={effect} onChange={(e) => setEffect(e.target.value)}>
                          <option>DENY</option>
                          <option>GRANT</option>
                        </Select>
                      </FormField>
                      <FormField label="Reason" htmlFor="overrideReason">
                        <Input id="overrideReason" value={reason} onChange={(e) => setReason(e.target.value)} />
                      </FormField>
                      <Button type="submit">Save override</Button>
                    </form>
                  )}
                </div>
              )}

              {(canToggleSelected || (canTargetSelected && hasPermission("users.regenerate_temp_password"))) && (
                <div className={styles.actionGroup}>
                  <h3 className={styles.actionGroupTitle}>Credential &amp; security-sensitive</h3>

                  {tempPassword && (
                    <div className={styles.credentialReveal} role="status">
                      <span className={styles.credentialText}>
                        <span className={styles.credentialLabel}>New temporary password (shown once)</span>
                        <span className={styles.credentialValue}>{tempPassword}</span>
                        <span className={styles.credentialHint}>It will not be shown again — copy it now if needed.</span>
                      </span>
                      <Button variant="secondary" onClick={() => setTempPassword(null)}>
                        Dismiss
                      </Button>
                    </div>
                  )}

                  <div className={styles.actionRow}>
                    {canToggleSelected &&
                      (selected.isActive ? (
                        <Button variant="danger" onClick={() => setDeactivateOpen(true)}>
                          Deactivate
                        </Button>
                      ) : (
                        <Button variant="secondary" onClick={() => setActive(true)}>
                          Activate
                        </Button>
                      ))}
                    {canTargetSelected && hasPermission("users.regenerate_temp_password") && (
                      <Button variant="danger" onClick={() => setRegenOpen(true)}>
                        Regenerate temporary password
                      </Button>
                    )}
                  </div>

                  <ConfirmActionDialog
                    open={regenOpen}
                    onClose={() => setRegenOpen(false)}
                    title="Regenerate temporary password"
                    message="Generate a new temporary password for this first-login account. Any previous temporary credential/session will stop working."
                    confirmLabel="Generate"
                    variant="danger"
                    onConfirm={regenerateTempPassword}
                  />
                  <ConfirmActionDialog
                    open={deactivateOpen}
                    onClose={() => setDeactivateOpen(false)}
                    title="Deactivate account"
                    message={`Deactivate ${selected.fullName}'s account? They will immediately lose access until reactivated.`}
                    confirmLabel="Confirm"
                    variant="danger"
                    onConfirm={() => setActive(false)}
                  />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
