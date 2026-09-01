import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { LoadingState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { RecordErrorState } from "../../../shared/components/RecordErrorState.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { EMPLOYEE_STATUS_TONE } from "../constants.js";
import * as api from "../api.js";
import { ProfilePhoto } from "../components/ProfilePhoto.jsx";
import styles from "./EmployeeDetailPage.module.css";

// Mirrors employees.service.js's ALLOWED_STATUS_TRANSITIONS exactly — the
// backend remains authoritative; this only keeps the UI from offering a
// transition (e.g. RESIGNED -> ACTIVE) that will always be rejected.
const STATUS_TRANSITIONS = {
  ACTIVE: ["INACTIVE", "RESIGNED", "TERMINATED"],
  INACTIVE: ["ACTIVE"],
  RESIGNED: [],
  TERMINATED: [],
};
const REASON_REQUIRED_STATUSES = new Set(["RESIGNED", "TERMINATED"]);
const DESTRUCTIVE_STATUSES = new Set(["RESIGNED", "TERMINATED"]);

const TABS = ["Overview", "Profile", "Assignments", "Compensation", "Contracts", "Documents", "Rotation", "Leave", "History"];

// The endings a CURRENT contract supports. A finalized contract is never
// rewritten — this records what happened to it.
const CONTRACT_TRANSITIONS = [
  ["SUPERSEDED", "Superseded"],
  ["EXPIRED", "Expired"],
  ["TERMINATED", "Terminated"],
];

export function EmployeeDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const [employee, setEmployee] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("Overview");
  const [sites, setSites] = useState([]);

  const load = useCallback(async () => {
    try {
      const response = await api.getEmployee(id);
      setEmployee(response.data);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Resolves a human-readable Site name for the identity header only — the
  // same existing endpoint the Assignments tab already uses for its own,
  // separate purpose (target-site selection), under the same permission
  // gate (a plain employees.view-only actor, e.g. Upper Management, simply
  // never calls it and the header falls back to showing the site id).
  useEffect(() => {
    if (!hasPermission("employees.transfer")) return;
    api
      .listSites()
      .then((r) => setSites(r.data))
      .catch(() => {});
  }, [hasPermission]);

  if (error) return <RecordErrorState error={error} onRetry={load} fallback="Unable to load this employee." />;
  if (!employee) return <LoadingState />;

  const siteName = sites.find((s) => s.id === employee.primarySiteId)?.name || employee.primarySiteId;

  return (
    <div>
      <div className={styles.identity}>
        <div className={styles.identityTitleRow}>
          <h1 className={styles.identityName}>{employee.fullLegalName}</h1>
          <StatusBadge tone={EMPLOYEE_STATUS_TONE[employee.status] || "neutral"} label={formatEnumLabel(employee.status)} />
        </div>
        <p className={styles.identityCode}>{employee.employeeCode}</p>
        <div className={styles.identityMeta}>
          <span>{employee.positionName || "No position"}</span>
          <span>{employee.departmentName || "No department"}</span>
          <span>{siteName || "No site"}</span>
        </div>
      </div>

      <div className={styles.tabScroller}>
        <nav className={styles.tabNav}>
          {TABS.map((t) => (
            <Button key={t} variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>
              {t}
            </Button>
          ))}
        </nav>
      </div>

      <div className={styles.panel}>
        {tab === "Overview" && <OverviewTab employee={employee} onChanged={load} hasPermission={hasPermission} />}
        {tab === "Profile" && <ProfileTab employeeId={id} />}
        {tab === "Assignments" && <AssignmentsTab employee={employee} hasPermission={hasPermission} onChanged={load} />}
        {tab === "Compensation" && <CompensationTab employeeId={id} hasPermission={hasPermission} />}
        {tab === "Contracts" && <ContractsTab employeeId={id} hasPermission={hasPermission} />}
        {tab === "Documents" && <DocumentsTab employeeId={id} hasPermission={hasPermission} />}
        {tab === "Rotation" && <RotationTab employeeId={id} hasPermission={hasPermission} />}
        {tab === "Leave" && <EmployeeLeaveTab employeeId={id} hasPermission={hasPermission} />}
        {tab === "History" && <BusinessHistoryTab employeeId={id} />}
      </div>
    </div>
  );
}

function ProfileTab({ employeeId }) {
  const [profile, setProfile] = useState(null);
  const loadPhoto = useCallback(() => api.getEmployeePhotoBlob(employeeId), [employeeId]);
  useEffect(() => { api.getEmployeeProfile(employeeId).then((result) => setProfile(result.data)); }, [employeeId]);
  if (!profile) return <LoadingState />;
  return <div><ProfilePhoto load={loadPhoto} alt={`${profile.employee.full_legal_name} profile`} /><h3>Personal details</h3><p>CNIC: {profile.personalDetails?.cnic || "—"}</p><p>Mobile: {profile.personalDetails?.mobile || "—"}</p><p>Personal email: {profile.personalDetails?.personal_email || "—"}</p><p>Address: {profile.personalDetails?.address || "—"}</p><h3>Emergency contacts</h3>{profile.emergencyContacts.map((contact) => <p key={contact.id}>{contact.name} — {contact.phone}</p>)}<h3>Additional information</h3>{profile.customFieldValues.map((field) => <p key={field.fieldId}>{field.label}: {String(field.value ?? "—")}</p>)}</div>;
}

function AssignmentsTab({ employee, hasPermission, onChanged }) {
  const [history, setHistory] = useState([]);
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(employee.primarySiteId || "");
  const [departments, setDepartments] = useState([]);
  const [positions, setPositions] = useState([]);
  const [types, setTypes] = useState([]);
  const [departmentId, setDepartmentId] = useState(employee.departmentId || "");
  const [positionId, setPositionId] = useState(employee.positionId || "");
  const [employmentTypeId, setEmploymentTypeId] = useState(employee.employmentTypeId || "");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState(null);
  const load = useCallback(() => api.getEmployeeAssignments(employee.id).then((result) => setHistory(result.data)), [employee.id]);

  // Target site defaults to the employee's current site (pre-filling the
  // Department/Position below with their current assignment). A
  // site-scoped actor's listSites() only ever returns that one site (no
  // selector rendered, matching AddEmployeePage's convention); an all-site
  // actor sees every active site and may pick a different one for an
  // immediate cross-site transfer — createTransfer already supports and
  // authorizes that (siteId input, company-wide scope required).
  useEffect(() => {
    load();
    if (hasPermission("employees.transfer")) {
      api.listSites().then((r) => setSites(r.data));
      api.listEmploymentTypes().then((r) => setTypes(r.data));
    }
  }, [load, hasPermission]);

  // Active, site-scoped selectors for both Department and Position — never
  // the all-site/inactive-inclusive management catalog. Re-fetches whenever
  // the target site changes (including the initial employee.primarySiteId).
  useEffect(() => {
    if (!hasPermission("employees.transfer") || !siteId) return;
    api.listDepartments(siteId).then((r) => setDepartments(r.data));
    api.listPositions(siteId).then((r) => setPositions(r.data));
  }, [siteId, hasPermission]);

  function changeSite(nextSiteId) {
    setSiteId(nextSiteId);
    // A Department/Position chosen under the previous site is not
    // necessarily valid (or even the same row id) under the new one.
    setDepartmentId("");
    setPositionId("");
  }

  async function transfer(event) {
    event.preventDefault();
    try {
      await api.transferEmployee(employee.id, {
        siteId,
        departmentId: departmentId || null,
        positionId: positionId || null,
        employmentTypeId: employmentTypeId || null,
        effectiveDate,
        reason,
      });
      setMessage("Assignment recorded.");
      load();
      onChanged();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div>
      {message && (
        <p className={styles.actionMessage} role="status">
          {message}
        </p>
      )}

      <h3 className={styles.actionGroupTitle}>Assignment history</h3>
      {history.length === 0 && <p className={styles.detailValue}>No assignment history yet.</p>}
      <ul className={styles.historyList}>
        {history.map((item) => (
          <li key={item.id} className={styles.historyRow}>
            <span className={styles.historyDate}>{item.effective_date}</span>
            <span>{item.department_name || "No department"} · {item.position_name || "No position"}</span>
          </li>
        ))}
      </ul>

      {hasPermission("employees.transfer") && (
        <form onSubmit={transfer} className={styles.transferForm}>
          <h3 className={styles.actionGroupTitle}>Record transfer / assignment</h3>
          <div className={styles.formGrid}>
            {sites.length > 1 && (
              <FormField label="Site" htmlFor="transferSite" required>
                <Select id="transferSite" value={siteId} onChange={(e) => changeSite(e.target.value)} required>
                  <option value="">— Select a site —</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}
            <FormField label="Department" htmlFor="transferDepartment">
              <Select id="transferDepartment" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={!siteId}>
                <option value="">None</option>
                {departments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Position" htmlFor="transferPosition">
              <Select id="transferPosition" value={positionId} onChange={(e) => setPositionId(e.target.value)} disabled={!siteId}>
                <option value="">None</option>
                {positions.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Employment type" htmlFor="transferType">
              <Select id="transferType" value={employmentTypeId} onChange={(e) => setEmploymentTypeId(e.target.value)}>
                <option value="">None</option>
                {types.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Effective date" htmlFor="transferDate" required>
              <Input id="transferDate" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required />
            </FormField>
            <FormField label="Reason" htmlFor="transferReason" hint="Optional notes for this transfer.">
              <Input id="transferReason" value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
          </div>
          <div className={styles.formActions}>
            <Button type="submit">Record assignment / transfer</Button>
          </div>
        </form>
      )}
    </div>
  );
}

function OverviewTab({ employee, onChanged, hasPermission }) {
  const [message, setMessage] = useState(null);
  const [email, setEmail] = useState("");
  const [linkableUsers, setLinkableUsers] = useState(null);
  const [linkUserId, setLinkUserId] = useState("");

  // Linking an EXISTING account instead of minting a second one. Without this
  // the only offered path was "create login", so a person who already had an
  // account — a Gate Pass user being onboarded into Workforce, say — got a
  // duplicate identity. The candidate list is loaded on demand: it needs
  // users.view, which the account-linking actor may or may not also hold.
  async function loadLinkableUsers() {
    setMessage(null);
    try {
      const response = await api.listUsers();
      const candidates = response.data.filter((user) => !user.employee_id);
      setLinkableUsers(candidates);
      if (candidates[0]) setLinkUserId(candidates[0].id);
    } catch (err) {
      setMessage(
        err instanceof ApiError
          ? `Unable to list existing accounts: ${err.message}`
          : "Unable to list existing accounts.",
      );
    }
  }

  async function linkExistingUser(event) {
    event.preventDefault();
    try {
      await api.linkExistingUserToEmployee(employee.id, { userId: linkUserId });
      setMessage("Existing account linked to this employee.");
      setLinkableUsers(null);
      onChanged();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to link the existing account.");
    }
  }

  async function createLogin(event) {
    event.preventDefault();
    try {
      const response = await api.createEmployeeLogin(employee.id, { email });
      setMessage(
        `Login created. Temporary password (shown once, share securely): ${response.data.temporaryPassword}`,
      );
      onChanged();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to create login.");
    }
  }

  async function resetPassword() {
    try {
      const response = await api.resetEmployeeLoginPassword(employee.id);
      setMessage(`Password reset. New temporary password (shown once): ${response.data.temporaryPassword}`);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to reset password.");
    }
  }

  const [pendingStatus, setPendingStatus] = useState(null);

  // Errors (validation, or the Governance instruction when a privileged
  // linked User is still active) are shown INSIDE the dialog by
  // ConfirmActionDialog/ReasonActionDialog itself, which also keeps the
  // dialog open on failure — nothing to catch here.
  async function submitStatusChange(status, reason) {
    await api.changeEmployeeStatus(employee.id, reason ? { status, reason } : { status });
    onChanged();
  }

  return (
    <div>
      <div className={styles.detailsGrid}>
        <div>
          <span className={styles.detailLabel}>Department</span>
          <span className={styles.detailValue}>{employee.departmentName || "—"}</span>
        </div>
        <div>
          <span className={styles.detailLabel}>Position</span>
          <span className={styles.detailValue}>{employee.positionName || "—"}</span>
        </div>
        <div>
          <span className={styles.detailLabel}>Employment type</span>
          <span className={styles.detailValue}>{employee.employmentTypeName || "—"}</span>
        </div>
      </div>

      {message && (
        <p className={styles.actionMessage} role="status">
          {message}
        </p>
      )}

      {/* Account actions: routine (create/reset login) vs. permanent
          offboarding are visually separated so a permanent action is never
          one accidental click away from a routine one. */}
      <div className={styles.actionGroup}>
        <h3 className={styles.actionGroupTitle}>Account</h3>
        <div className={styles.actionRow}>
          {!employee.hasLogin && hasPermission("employees.account.create") && (
            <form onSubmit={createLogin} className={styles.inlineForm}>
              <FormField label="Email" htmlFor="loginEmail" required>
                <Input id="loginEmail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </FormField>
              <Button type="submit">Create login (EMPLOYEE role)</Button>
            </form>
          )}

          {employee.hasLogin && hasPermission("employees.account.reset") && (
            <Button variant="secondary" onClick={resetPassword}>
              Reset login password
            </Button>
          )}

          {!employee.hasLogin && hasPermission("employees.account.link_existing") && (
            linkableUsers === null ? (
              <Button variant="secondary" onClick={loadLinkableUsers}>
                Link an existing account
              </Button>
            ) : (
              <form onSubmit={linkExistingUser} className={styles.inlineForm}>
                <FormField label="Existing account" htmlFor="linkExistingUser" required>
                  <Select
                    id="linkExistingUser"
                    value={linkUserId}
                    onChange={(event) => setLinkUserId(event.target.value)}
                    required
                  >
                    {linkableUsers.length === 0 && <option value="">No unlinked accounts</option>}
                    {linkableUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.full_name} · {user.email}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <Button type="submit" disabled={linkableUsers.length === 0}>
                  Link account
                </Button>
                <Button variant="secondary" onClick={() => setLinkableUsers(null)}>
                  Cancel
                </Button>
              </form>
            )
          )}

          {employee.hasLogin === false &&
            !hasPermission("employees.account.create") &&
            !hasPermission("employees.account.reset") &&
            !hasPermission("employees.account.link_existing") && (
              <p className={styles.detailValue}>No login account.</p>
            )}
        </div>
      </div>

      {hasPermission("employees.status_change") && (
        <div className={styles.actionGroup}>
          <h3 className={styles.actionGroupTitle}>Status</h3>
          <div className={styles.actionRow}>
            {(STATUS_TRANSITIONS[employee.status] || []).map((s) => (
              <Button
                key={s}
                variant={DESTRUCTIVE_STATUSES.has(s) ? "danger" : "secondary"}
                onClick={() => setPendingStatus(s)}
              >
                {s}
              </Button>
            ))}
            {(STATUS_TRANSITIONS[employee.status] || []).length === 0 && (
              <p className={styles.detailValue}>No further status changes are available.</p>
            )}
          </div>
        </div>
      )}

      {pendingStatus &&
        (REASON_REQUIRED_STATUSES.has(pendingStatus) ? (
          <ReasonActionDialog
            open
            onClose={() => setPendingStatus(null)}
            title={`Change status to ${pendingStatus}`}
            message={`This permanently changes the employee's status to ${pendingStatus}. A reason is required.`}
            confirmLabel="Confirm"
            onConfirm={(reason) => submitStatusChange(pendingStatus, reason)}
          />
        ) : (
          <ConfirmActionDialog
            open
            onClose={() => setPendingStatus(null)}
            title={`Change status to ${pendingStatus}`}
            message={`Change the employee's status to ${pendingStatus}?`}
            confirmLabel="Confirm"
            onConfirm={() => submitStatusChange(pendingStatus, undefined)}
          />
        ))}
    </div>
  );
}

function CompensationTab({ employeeId, hasPermission }) {
  const [current, setCurrent] = useState(undefined);
  const [history, setHistory] = useState([]);
  const [amount, setAmount] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const [curRes, histRes] = await Promise.all([
        api.getEmployeeCompensationCurrent(employeeId),
        hasPermission("compensation.history") ? api.getEmployeeCompensationHistory(employeeId) : Promise.resolve({ data: [] }),
      ]);
      setCurrent(curRes.data);
      setHistory(histRes.data);
    } catch {
      setCurrent(null);
    }
  }, [employeeId, hasPermission]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function record(event) {
    event.preventDefault();
    try {
      await api.recordCompensation(employeeId, { amount: Number(amount), currency: "PKR", effectiveDate, reason });
      setMessage("Recorded.");
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to record compensation.");
    }
  }

  if (current === undefined) return <LoadingState />;
  if (current === null) return <p>You do not have permission to view compensation for this employee.</p>;

  return (
    <div>
      <p>Current: {current ? `${current.amount} ${current.currency}` : "Not set"}</p>
      {history.length > 0 && (
        <div>
          <h3>History</h3>
          {history.map((r) => (
            <p key={r.id}>
              {r.effective_date}: {r.amount} {r.currency}
            </p>
          ))}
        </div>
      )}
      {hasPermission("compensation.change") && (
        <form onSubmit={record}>
          {message && <p role="status">{message}</p>}
          <FormField label="Amount" htmlFor="amount">
            <Input id="amount" type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </FormField>
          <FormField label="Effective date" htmlFor="effectiveDate">
            <Input id="effectiveDate" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </FormField>
          <FormField label="Reason" htmlFor="reason">
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <Button type="submit">Record new compensation</Button>
        </form>
      )}
    </div>
  );
}

function ContractsTab({ employeeId, hasPermission }) {
  const [contracts, setContracts] = useState([]);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    try {
      const response = await api.listEmployeeContracts(employeeId);
      setContracts(response.data);
    } catch {
      setContracts([]);
    }
  }, [employeeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function createDraft() {
    try {
      await api.createContractDraft(employeeId, { kind: "ORIGINAL" });
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to create draft.");
    }
  }

  async function uploadFile(contractId, event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      await api.uploadContractFile(employeeId, contractId, formData);
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to upload file.");
    }
  }

  async function saveDraftDetails(contractId, details) {
    setMessage(null);
    try {
      await api.updateContractDraft(employeeId, contractId, details);
      setMessage("Contract details saved.");
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to save contract details.");
    }
  }

  async function finalize(contractId) {
    setMessage(null);
    try {
      await api.finalizeContract(employeeId, contractId);
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to finalize.");
    }
  }

  async function transition(contractId, status, label) {
    setMessage(null);
    try {
      await api.transitionContract(employeeId, contractId, { status });
      setMessage(`Contract marked ${label.toLowerCase()}.`);
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to record the contract transition.");
    }
  }

  async function download(contract) { const blob = await api.getContractBlob(employeeId, contract.id); const url = URL.createObjectURL(blob); const link = window.document.createElement("a"); link.href = url; link.download = `${contract.contract_number}.pdf`; link.click(); URL.revokeObjectURL(url); }

  return (
    <div>
      {message && <p role="alert">{message}</p>}
      {hasPermission("contract.create") && <Button onClick={createDraft}>New draft contract</Button>}
      {contracts.map((c) => (
        <div key={c.id}>
          <p>
            {c.contract_number} ({c.kind}) — {c.status}
          </p>
          {c.status === "DRAFT" && hasPermission("contract.edit_draft") && (
            <>
              <ContractDraftFields contract={c} onSave={saveDraftDetails} />
              <input type="file" accept="application/pdf" onChange={(e) => uploadFile(c.id, e)} />
            </>
          )}
          {c.status === "DRAFT" && c.has_file && hasPermission("contract.finalize") && (
            <Button onClick={() => finalize(c.id)}>Finalize (becomes immutable)</Button>
          )}
          {c.status !== "DRAFT" && hasPermission("contract.download") && <Button variant="secondary" onClick={() => download(c)}>Download</Button>}
          {c.status !== "DRAFT" && hasPermission("contract.amend") && <Button variant="secondary" onClick={async () => { await api.createContractDraft(employeeId, { kind: "AMENDMENT", amendsContractId: c.id }); load(); }}>Create amendment</Button>}
          {/* A finalized contract is never rewritten or deleted; recording
              what became of it is the only supported ending. The backend has
              always accepted this (POST .../transition) — nothing offered it,
              so a CURRENT contract could never be marked terminated or
              expired through the product. Only CURRENT transitions. */}
          {c.status === "CURRENT" && (hasPermission("contract.edit_draft") || hasPermission("contract.finalize")) && (
            <div className={styles.contractTransitions}>
              {CONTRACT_TRANSITIONS.map(([status, label]) => (
                <Button key={status} variant="secondary" onClick={() => transition(c.id, status, label)}>
                  {label}
                </Button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// The effective start date and terms summary are original contract terms:
// once finalized the DB trigger freezes them permanently, so they have to be
// captured while the contract is still a DRAFT. The server rejects an
// incomplete finalization regardless of what this form does — these controls
// exist so a legitimate user can satisfy that rule, not to enforce it.
function ContractDraftFields({ contract, onSave }) {
  const [effectiveStartDate, setEffectiveStartDate] = useState(contract.effective_start_date?.slice(0, 10) ?? "");
  const [termsSummary, setTermsSummary] = useState(contract.terms_summary ?? "");

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSave(contract.id, { effectiveStartDate, termsSummary });
      }}
    >
      <FormField label="Effective start date" htmlFor={`contractStart-${contract.id}`}>
        <Input
          id={`contractStart-${contract.id}`}
          type="date"
          value={effectiveStartDate}
          onChange={(e) => setEffectiveStartDate(e.target.value)}
        />
      </FormField>
      <FormField label="Terms summary" htmlFor={`contractTerms-${contract.id}`}>
        <Input
          id={`contractTerms-${contract.id}`}
          value={termsSummary}
          onChange={(e) => setTermsSummary(e.target.value)}
        />
      </FormField>
      <Button type="submit" variant="secondary">
        Save contract details
      </Button>
    </form>
  );
}

function DocumentsTab({ employeeId, hasPermission }) {
  const [documents, setDocuments] = useState([]);
  const [types, setTypes] = useState([]);
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [file, setFile] = useState(null);
  const [openVersionsFor, setOpenVersionsFor] = useState(null);
  const [versions, setVersions] = useState([]);

  // Loaded on demand rather than with the list: most viewers only ever need
  // the current version, and a request per document type on every open would
  // be paid whether or not anyone looks.
  async function toggleVersions(typeId) {
    if (openVersionsFor === typeId) {
      setOpenVersionsFor(null);
      setVersions([]);
      return;
    }
    const response = await api.getEmployeeDocumentVersions(employeeId, typeId);
    setVersions(response.data);
    setOpenVersionsFor(typeId);
  }

  const load = useCallback(async () => {
    const response = await api.listEmployeeDocuments(employeeId);
    setDocuments(response.data);
    if (hasPermission("employee_documents.manage")) {
      const typeResponse = await api.listDocumentTypesManage(); setTypes(typeResponse.data.filter((type) => type.hr_can_upload ?? type.can_upload)); if (!documentTypeId && typeResponse.data[0]) setDocumentTypeId(typeResponse.data[0].id);
    }
  }, [employeeId, hasPermission, documentTypeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function verify(documentId, status) {
    await api.verifyDocument(employeeId, documentId, { status });
    load();
  }

  async function upload(event) { event.preventDefault(); const form = new FormData(); form.append("documentTypeId", documentTypeId); form.append("file", file); await api.uploadEmployeeDocument(employeeId, form); setFile(null); load(); }
  async function download(document) { const blob = await api.getDocumentBlob(employeeId, document.id); const url = URL.createObjectURL(blob); const link = window.document.createElement("a"); link.href = url; link.download = document.original_filename || "document"; link.click(); URL.revokeObjectURL(url); }

  return (
    <div>
      {hasPermission("employee_documents.manage") && <form onSubmit={upload}><FormField label="Document type" htmlFor="employeeDocumentType"><Select id="employeeDocumentType" value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</Select></FormField><FormField label="File" htmlFor="employeeDocumentFile"><input id="employeeDocumentFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} required /></FormField><Button type="submit" disabled={!file}>Upload new version</Button></form>}
      {documents.map((d) => (
        <p key={d.id}>
          {d.document_type_name} — v{d.version} — {d.verification_status}
          {hasPermission("employee_documents.download") && <Button variant="secondary" onClick={() => download(d)}>Download</Button>}
          {/* Superseded versions are retained, never overwritten, so the
              history is the only way to reach an earlier one. The endpoint
              has always existed; nothing called it. */}
          <Button variant="secondary" onClick={() => toggleVersions(d.document_type_id)}>
            {openVersionsFor === d.document_type_id ? "Hide versions" : "Version history"}
          </Button>
          {hasPermission("employee_documents.manage") && <Button variant="secondary" onClick={async () => { await api.requestDocument(employeeId, { documentTypeId: d.document_type_id, note: "Replacement requested" }); }}>Request replacement</Button>}
          {hasPermission("employee_documents.verify") && d.verification_status === "UPLOADED" && (
            <>
              {" "}
              <Button variant="secondary" onClick={() => verify(d.id, "VERIFIED")}>
                Verify
              </Button>
              <Button variant="danger" onClick={() => verify(d.id, "NEEDS_REPLACEMENT")}>
                Needs replacement
              </Button>
            </>
          )}
        </p>
      ))}
      {openVersionsFor && (
        <div className={styles.versionHistory}>
          <h3 className={styles.versionTitle}>Version history</h3>
          {versions.length === 0 ? (
            <p>No earlier versions.</p>
          ) : (
            <ul className={styles.historyList}>
              {versions.map((version) => (
                <li key={version.id}>
                  <div className={styles.historyHeader}>
                    <strong>Version {version.version}</strong>
                    <span>{formatDateTime(version.uploaded_at)}</span>
                  </div>
                  <p className={styles.historySummary}>
                    {formatEnumLabel(version.verification_status)}
                    {version.original_filename ? ` · ${version.original_filename}` : ""}
                  </p>
                  {hasPermission("employee_documents.download") && (
                    <Button variant="secondary" onClick={() => download(version)}>
                      Download this version
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function EmployeeLeaveTab({ employeeId, hasPermission }) {
  const [requests, setRequests] = useState(null);
  const load = useCallback(() => api.getEmployeeLeave(employeeId).then((result) => setRequests(result.data)), [employeeId]);
  useEffect(() => { load(); }, [load]);
  if (!requests) return <LoadingState />;
  async function decide(id, status) { await api.decideLeave(id, { status }); load(); }
  return <div>{requests.length === 0 && <p>No leave requests.</p>}{requests.map((request) => <p key={request.id}>{request.start_date} to {request.end_date} · {request.status} {hasPermission("leave.approve") && request.status === "SUBMITTED" && <><Button onClick={() => decide(request.id, "APPROVED")}>Approve</Button><Button variant="danger" onClick={() => decide(request.id, "REJECTED")}>Reject</Button></>}</p>)}</div>;
}

function RotationTab({ employeeId, hasPermission }) {
  const [status, setStatus] = useState(undefined);
  const [days, setDays] = useState("");
  const [reason, setReason] = useState("");
  const [effectiveDate, setEffectiveDate] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await api.getEmployeeRotation(employeeId);
      setStatus(response.data);
    } catch {
      setStatus(null);
    }
  }, [employeeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function adjust(event) {
    event.preventDefault();
    await api.adjustRotation(employeeId, { days: Number(days), reason, effectiveDate });
    load();
  }

  if (status === undefined) return <LoadingState />;
  if (status === null) return <p>No permission.</p>;

  return (
    <div>
      <p>Balance: {status.balance}</p>
      {hasPermission("rotation.adjust") && (
        <form onSubmit={adjust}>
          <FormField label="Days (+/-)" htmlFor="days">
            <Input id="days" type="number" value={days} onChange={(e) => setDays(e.target.value)} />
          </FormField>
          <FormField label="Reason" htmlFor="reason">
            <Input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <FormField label="Effective date" htmlFor="effectiveDate">
            <Input id="effectiveDate" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </FormField>
          <Button type="submit">Adjust</Button>
        </form>
      )}
    </div>
  );
}

// The append-only record of what has happened to this Employee. The backend
// has exposed it since the Workforce foundation; nothing ever read it, so an
// employee's own history was invisible in the product.
//
// Removed entries are SHOWN as removed rather than hidden: the database
// trigger rejects deletion outright and permits only the logical-removal
// columns, so "removed" is part of the record, not the absence of one.
function BusinessHistoryTab({ employeeId }) {
  const [state, setState] = useState({ entries: [], status: "loading", error: null });

  const load = useCallback(async () => {
    try {
      const response = await api.getEmployeeBusinessHistory(employeeId);
      setState({ entries: response.data, status: "ready", error: null });
    } catch (err) {
      setState({
        entries: [],
        status: "error",
        error: err instanceof ApiError ? err.message : "Unable to load business history.",
      });
    }
  }, [employeeId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (state.status === "loading") return <LoadingState message="Loading history…" />;
  if (state.status === "error") return <p role="alert">{state.error}</p>;
  if (state.entries.length === 0) {
    return <EmptyState title="No history yet" message="Employment events appear here as they happen." />;
  }

  return (
    <ul className={styles.historyList}>
      {state.entries.map((entry) => (
        <li key={entry.id} className={entry.is_removed ? styles.historyRemoved : undefined}>
          <div className={styles.historyHeader}>
            <strong>{formatEnumLabel(entry.event_type)}</strong>
            <span>{formatDateTime(entry.created_at)}</span>
          </div>
          {entry.summary && <p className={styles.historySummary}>{summaryText(entry.summary)}</p>}
          {entry.is_removed && (
            <p className={styles.historyRemovedNote}>
              Removed{entry.removed_reason ? `: ${entry.removed_reason}` : ""}. The entry itself is retained.
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}

// Summaries are structured JSON whose shape varies per event type, so this
// renders the pairs rather than guessing at a sentence per type.
//
// Their keys are camelCase JSON, not SCREAMING_SNAKE enum codes, so
// formatEnumLabel is the wrong formatter here — it would render
// "previousStatus" as "Previousstatus".
function summaryText(summary) {
  if (typeof summary === "string") return summary;
  return Object.entries(summary)
    .map(([key, value]) => `${humanizeKey(key)}: ${value}`)
    .join(" · ");
}

function humanizeKey(key) {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
