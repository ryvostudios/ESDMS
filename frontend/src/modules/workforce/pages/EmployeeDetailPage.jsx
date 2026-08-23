import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import { ReasonActionDialog } from "../../../shared/components/ReasonActionDialog.jsx";
import * as api from "../api.js";

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

const TABS = ["Overview", "Profile", "Assignments", "Compensation", "Contracts", "Documents", "Rotation", "Leave"];

export function EmployeeDetailPage() {
  const { id } = useParams();
  const { hasPermission } = useAuth();
  const [employee, setEmployee] = useState(null);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("Overview");

  const load = useCallback(async () => {
    try {
      const response = await api.getEmployee(id);
      setEmployee(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load employee.");
    }
  }, [id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!employee) return <LoadingState />;

  return (
    <div>
      <PageHeader title={employee.fullLegalName} description={`${employee.employeeCode} · ${employee.status}`} />
      <nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <Button key={t} variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>
            {t}
          </Button>
        ))}
      </nav>

      {tab === "Overview" && <OverviewTab employee={employee} onChanged={load} hasPermission={hasPermission} />}
      {tab === "Profile" && <ProfileTab employeeId={id} />}
      {tab === "Assignments" && <AssignmentsTab employee={employee} hasPermission={hasPermission} onChanged={load} />}
      {tab === "Compensation" && <CompensationTab employeeId={id} hasPermission={hasPermission} />}
      {tab === "Contracts" && <ContractsTab employeeId={id} hasPermission={hasPermission} />}
      {tab === "Documents" && <DocumentsTab employeeId={id} hasPermission={hasPermission} />}
      {tab === "Rotation" && <RotationTab employeeId={id} hasPermission={hasPermission} />}
      {tab === "Leave" && <EmployeeLeaveTab employeeId={id} hasPermission={hasPermission} />}
    </div>
  );
}

function ProfileTab({ employeeId }) {
  const [profile, setProfile] = useState(null);
  useEffect(() => { api.getEmployeeProfile(employeeId).then((result) => setProfile(result.data)); }, [employeeId]);
  if (!profile) return <LoadingState />;
  return <div><h3>Personal details</h3><p>CNIC: {profile.personalDetails?.cnic || "—"}</p><p>Mobile: {profile.personalDetails?.mobile || "—"}</p><p>Personal email: {profile.personalDetails?.personal_email || "—"}</p><p>Address: {profile.personalDetails?.address || "—"}</p><h3>Emergency contacts</h3>{profile.emergencyContacts.map((contact) => <p key={contact.id}>{contact.name} — {contact.phone}</p>)}<h3>Additional information</h3>{profile.customFieldValues.map((field) => <p key={field.fieldId}>{field.label}: {String(field.value ?? "—")}</p>)}</div>;
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

  return <div>{message && <p role="status">{message}</p>}<h3>Assignment history</h3>{history.map((item) => <p key={item.id}>{item.effective_date} — {item.department_name || "No department"} · {item.position_name || "No position"}</p>)}{hasPermission("employees.transfer") && <form onSubmit={transfer}>{sites.length > 1 && <FormField label="Site" htmlFor="transferSite" required><Select id="transferSite" value={siteId} onChange={(e) => changeSite(e.target.value)} required><option value="">— Select a site —</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></FormField>}<FormField label="Department" htmlFor="transferDepartment"><Select id="transferDepartment" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={!siteId}><option value="">None</option>{departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></FormField><FormField label="Position" htmlFor="transferPosition"><Select id="transferPosition" value={positionId} onChange={(e) => setPositionId(e.target.value)} disabled={!siteId}><option value="">None</option>{positions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></FormField><FormField label="Employment type" htmlFor="transferType"><Select id="transferType" value={employmentTypeId} onChange={(e) => setEmploymentTypeId(e.target.value)}><option value="">None</option>{types.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</Select></FormField><FormField label="Effective date" htmlFor="transferDate"><Input id="transferDate" type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} required /></FormField><FormField label="Reason" htmlFor="transferReason"><Input id="transferReason" value={reason} onChange={(e) => setReason(e.target.value)} /></FormField><Button type="submit">Record assignment / transfer</Button></form>}</div>;
}

function OverviewTab({ employee, onChanged, hasPermission }) {
  const [message, setMessage] = useState(null);
  const [email, setEmail] = useState("");

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
      <p>Site: {employee.primarySiteId}</p>
      <p>Department: {employee.departmentName || "—"}</p>
      <p>Position: {employee.positionName || "—"}</p>
      <p>Employment type: {employee.employmentTypeName || "—"}</p>
      {message && <p role="status">{message}</p>}

      {!employee.hasLogin && hasPermission("employees.account.create") && (
        <form onSubmit={createLogin}>
          <h3>Create login</h3>
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

      {hasPermission("employees.status_change") && (
        <div>
          <h3>Status</h3>
          {(STATUS_TRANSITIONS[employee.status] || []).map((s) => (
            <Button key={s} variant="secondary" onClick={() => setPendingStatus(s)}>
              {s}
            </Button>
          ))}
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

  async function finalize(contractId) {
    try {
      await api.finalizeContract(employeeId, contractId);
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to finalize.");
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
            <input type="file" accept="application/pdf" onChange={(e) => uploadFile(c.id, e)} />
          )}
          {c.status === "DRAFT" && c.has_file && hasPermission("contract.finalize") && (
            <Button onClick={() => finalize(c.id)}>Finalize (becomes immutable)</Button>
          )}
          {c.status !== "DRAFT" && hasPermission("contract.download") && <Button variant="secondary" onClick={() => download(c)}>Download</Button>}
          {c.status !== "DRAFT" && hasPermission("contract.amend") && <Button variant="secondary" onClick={async () => { await api.createContractDraft(employeeId, { kind: "AMENDMENT", amendsContractId: c.id }); load(); }}>Create amendment</Button>}
        </div>
      ))}
    </div>
  );
}

function DocumentsTab({ employeeId, hasPermission }) {
  const [documents, setDocuments] = useState([]);
  const [types, setTypes] = useState([]);
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [file, setFile] = useState(null);

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
