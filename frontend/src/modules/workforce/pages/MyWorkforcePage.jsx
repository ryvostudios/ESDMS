import { useEffect, useState, useCallback } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ApiError } from "../../../core/api/client.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Textarea, Select } from "../../../shared/components/FormField.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { formatDate } from "../../../shared/utilities/datetime.js";
import * as api from "../api.js";

// ESDMS-018: each child is gated by its OWN capability, never by
// profile.self.view as an umbrella. Documents/Rotation/Contracts/
// Compensation self-access is identity-based on the backend (no permission
// code exists or is required for it — see documents/rotation/contracts/
// compensation .service.js's isSelfActor checks); only Profile and Leave
// have an actual self permission gate.
const TAB_CONFIG = [
  { key: "Profile", allowed: (hasPermission) => hasPermission("profile.self.view") },
  { key: "Documents", allowed: () => true },
  { key: "Leave", allowed: (hasPermission) => hasPermission("leave.self.view") || hasPermission("leave.self.create") },
  { key: "Rotation", allowed: () => true },
  { key: "Contracts", allowed: () => true },
  { key: "Compensation", allowed: () => true },
];

export function MyWorkforcePage() {
  const { user, hasPermission } = useAuth();
  const availableTabs = TAB_CONFIG.filter((t) => t.allowed(hasPermission)).map((t) => t.key);
  const profileAllowed = availableTabs.includes("Profile");

  const [tab, setTab] = useState(() => availableTabs[0] || null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    // Loading (or failing to load) the profile object must never block
    // access to unrelated self-service tabs that don't need it at all.
    if (!user?.employeeId || !profileAllowed) {
      setLoading(false);
      setError(null);
      setProfile(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await api.getMyProfile();
      setProfile(response.data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load your profile.");
    } finally {
      setLoading(false);
    }
  }, [user?.employeeId, profileAllowed]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (!user?.employeeId) {
    if (hasPermission("employees.view")) {
      return <Navigate to="/workforce" replace />;
    }

    return (
      <ErrorState
        title="My Workforce unavailable"
        message="No Employee record is linked to your account."
      />
    );
  }

  if (availableTabs.length === 0) {
    return (
      <ErrorState
        title="My Workforce unavailable"
        message="You do not have access to any self-service feature."
      />
    );
  }

  if (tab === "Profile") {
    if (loading) return <LoadingState message="Loading your profile…" />;
    if (error) return <ErrorState message={error} onRetry={load} />;
    if (!profile) return null;
  }

  return (
    <div>
      <PageHeader
        title="My Workforce"
        description={profile ? `Profile ${profile.completion.percent}% complete` : "Self-service"}
      />
      <nav style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {availableTabs.map((t) => (
          <Button key={t} variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>
            {t}
          </Button>
        ))}
      </nav>

      {tab === "Profile" && profile && <ProfileTab profile={profile} onChanged={load} />}
      {tab === "Documents" && <DocumentsTab />}
      {tab === "Leave" && <LeaveTab />}
      {tab === "Rotation" && <RotationTab />}
      {tab === "Contracts" && <ContractsTab />}
      {tab === "Compensation" && <MyCompensationTab />}
    </div>
  );
}

function ProfileTab({ profile, onChanged }) {
  const [mobile, setMobile] = useState(profile.personalDetails?.mobile || "");
  const [address, setAddress] = useState(profile.personalDetails?.address || "");
  const [cnic, setCnic] = useState(profile.personalDetails?.cnic || "");
  const [personalEmail, setPersonalEmail] = useState(profile.personalDetails?.personal_email || "");
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [fields, setFields] = useState([]);
  const [fieldValues, setFieldValues] = useState(Object.fromEntries(profile.customFieldValues.map((field) => [field.fieldId, field.value ?? ""])));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  async function savePersonalDetails(event) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      await api.updateMyPersonalDetails({ mobile, address, cnic, personalEmail });
      setMessage("Saved.");
      onChanged();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to save.");
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => { api.listCustomFieldsSelf().then((result) => setFields(result.data)); }, []);

  async function addContact(event) {
    event.preventDefault();
    try { await api.addMyEmergencyContact({ name: contactName, phone: contactPhone }); setContactName(""); setContactPhone(""); onChanged(); }
    catch (err) { setMessage(err instanceof ApiError ? err.message : "Unable to add emergency contact."); }
  }

  async function saveField(field) {
    let value = fieldValues[field.id];
    if (["NUMBER", "PERCENTAGE"].includes(field.field_type)) value = Number(value);
    if (field.field_type === "BOOLEAN") value = value === true || value === "true";
    try { await api.setMyFieldValue(field.id, value); setMessage(`${field.label} saved.`); onChanged(); }
    catch (err) { setMessage(err instanceof ApiError ? err.message : "Unable to save field."); }
  }

  async function handlePhotoChange(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("photo", file);
    try {
      await api.uploadMyPhoto(formData);
      setMessage("Photo updated.");
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to upload photo.");
    }
  }

  return (
    <div>
      <h2>{profile.employee.full_legal_name}</h2>
      <p>
        {profile.employee.employee_code} · {profile.employee.status}
      </p>

      <FormField label="Profile photo" htmlFor="photo">
        <input id="photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={handlePhotoChange} />
      </FormField>

      <form onSubmit={savePersonalDetails}>
        {message && <p role="status">{message}</p>}
        <FormField label="Mobile" htmlFor="mobile">
          <Input id="mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} disabled={saving} />
        </FormField>
        <FormField label="CNIC" htmlFor="cnic">
          <Input id="cnic" value={cnic} onChange={(e) => setCnic(e.target.value)} disabled={saving} />
        </FormField>
        <FormField label="Address" htmlFor="address">
          <Textarea id="address" value={address} onChange={(e) => setAddress(e.target.value)} disabled={saving} />
        </FormField>
        <FormField label="Personal email" htmlFor="personalEmail">
          <Input id="personalEmail" type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} disabled={saving} />
        </FormField>
        <Button type="submit" loading={saving}>
          Save
        </Button>
      </form>

      <h3>Emergency contacts</h3>
      {profile.emergencyContacts.map((contact) => <p key={contact.id}>{contact.name} — {contact.phone} <Button variant="secondary" onClick={async () => { await api.removeMyEmergencyContact(contact.id); onChanged(); }}>Remove</Button></p>)}
      <form onSubmit={addContact}>
        <FormField label="Contact name" htmlFor="contactName"><Input id="contactName" value={contactName} onChange={(e) => setContactName(e.target.value)} required /></FormField>
        <FormField label="Contact phone" htmlFor="contactPhone"><Input id="contactPhone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} required /></FormField>
        <Button type="submit">Add emergency contact</Button>
      </form>

      {fields.length > 0 && (
        <div>
          <h3>Additional information</h3>
          {fields.map((field) => <div key={field.id}><FormField label={field.label} htmlFor={`field-${field.id}`}><Input id={`field-${field.id}`} value={String(fieldValues[field.id] ?? "")} disabled={!field.employee_can_edit} onChange={(e) => setFieldValues((current) => ({ ...current, [field.id]: e.target.value }))} /></FormField>{field.employee_can_edit && <Button variant="secondary" onClick={() => saveField(field)}>Save field</Button>}</div>)}
        </div>
      )}

      {profile.completion.missingCoreFields.length > 0 && (
        <p>Missing: {profile.completion.missingCoreFields.join(", ")}</p>
      )}
    </div>
  );
}

function DocumentsTab() {
  const [documents, setDocuments] = useState([]);
  const [requests, setRequests] = useState([]);
  const [error, setError] = useState(null);
  const [types, setTypes] = useState([]);
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [file, setFile] = useState(null);
  const [expiryDate, setExpiryDate] = useState("");

  const load = useCallback(async () => {
    try {
      const [docsRes, reqRes, typeRes] = await Promise.all([api.getMyDocuments(), api.getMyDocumentRequests(), api.listDocumentTypesSelf()]);
      setDocuments(docsRes.data);
      setRequests(reqRes.data);
      setTypes(typeRes.data.filter((type) => type.can_upload));
      if (typeRes.data[0]) setDocumentTypeId((current) => current || typeRes.data[0].id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Unable to load documents.");
    }
  }, []);

  async function upload(event) {
    event.preventDefault();
    const form = new FormData(); form.append("documentTypeId", documentTypeId); if (expiryDate) form.append("expiryDate", expiryDate); form.append("file", file);
    try { await api.uploadMyDocument(form); setFile(null); load(); } catch (err) { setError(err.message); }
  }

  async function download(document) {
    const blob = await api.getMyDocumentBlob(document.id); const url = URL.createObjectURL(blob); const link = window.document.createElement("a"); link.href = url; link.download = document.original_filename || "document"; link.click(); URL.revokeObjectURL(url);
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  return (
    <div>
      {error && <ErrorState message={error} onRetry={load} />}
      {requests.length > 0 && (
        <div role="status">
          <h3>Pending actions</h3>
          {requests.map((r) => (
            <p key={r.id}>Please upload: {r.document_type_name}</p>
          ))}
        </div>
      )}
      <h3>My documents</h3>
      {types.length > 0 && <form onSubmit={upload}><FormField label="Document type" htmlFor="myDocumentType"><Select id="myDocumentType" value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}>{types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}</Select></FormField><FormField label="Expiry date (when applicable)" htmlFor="myDocumentExpiry"><Input id="myDocumentExpiry" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></FormField><FormField label="File" htmlFor="myDocumentFile"><input id="myDocumentFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} required /></FormField><Button type="submit" disabled={!file}>Upload new version</Button></form>}
      {documents.length === 0 && <p>No documents uploaded yet.</p>}
      {documents.map((d) => (
        <p key={d.id}>
          {d.document_type_name} — v{d.version} — {d.verification_status} <Button variant="secondary" onClick={() => download(d)}>Download</Button>
        </p>
      ))}
    </div>
  );
}

function LeaveTab() {
  const { hasPermission } = useAuth();
  const [types, setTypes] = useState([]);
  const [requests, setRequests] = useState([]);
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [requestedDays, setRequestedDays] = useState(1);
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    const [typesRes, requestsRes] = await Promise.all([api.listLeaveTypes(), api.getMyLeave()]);
    setTypes(typesRes.data);
    setRequests(requestsRes.data);
    if (typesRes.data[0]) setLeaveTypeId(typesRes.data[0].id);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function handleSubmit(event) {
    event.preventDefault();
    setMessage(null);
    try {
      await api.submitMyLeave({ leaveTypeId, startDate, endDate, requestedDays: Number(requestedDays), reason });
      setMessage("Leave request submitted.");
      load();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Unable to submit leave.");
    }
  }

  return (
    <div>
      <h3>Apply for leave</h3>
      <form onSubmit={handleSubmit}>
        {message && <p role="status">{message}</p>}
        <FormField label="Leave type" htmlFor="leaveType">
          <Select id="leaveType" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Start date" htmlFor="startDate">
          <Input id="startDate" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </FormField>
        <FormField label="End date" htmlFor="endDate">
          <Input id="endDate" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </FormField>
        <FormField label="Days" htmlFor="requestedDays">
          <Input id="requestedDays" type="number" min="0.5" step="0.5" value={requestedDays} onChange={(e) => setRequestedDays(e.target.value)} />
        </FormField>
        <FormField label="Reason" htmlFor="reason">
          <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <Button type="submit">Submit</Button>
      </form>

      <h3>My requests</h3>
      {requests.map((r) => (
        <p key={r.id}>
          {formatDate(r.start_date)} – {formatDate(r.end_date)} ({r.leave_type_name}) — {r.status}
          {r.status === "SUBMITTED" && hasPermission("leave.self.cancel") && (
            <Button variant="secondary" onClick={async () => { await api.cancelMyLeave(r.id); load(); }}>Cancel</Button>
          )}
        </p>
      ))}
    </div>
  );
}

function MyCompensationTab() {
  const [current, setCurrent] = useState(undefined);
  useEffect(() => { api.getMyCompensation().then((result) => setCurrent(result.data)).catch(() => setCurrent(null)); }, []);
  if (current === undefined) return <LoadingState />;
  return <div><h3>My current compensation</h3><p>{current ? `${current.amount} ${current.currency} effective ${formatDate(current.effective_date)}` : "No current compensation record."}</p></div>;
}

function RotationTab() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.getMyRotation().then((res) => setStatus(res.data));
  }, []);

  if (!status) return <LoadingState />;

  return (
    <div>
      <p>Policy: {status.policy ? `${status.policy.name} (${status.policy.work_days}/${status.policy.off_days})` : "Not assigned"}</p>
      <p>Off-day balance: {status.balance}</p>
      <h3>History</h3>
      {status.ledger.map((entry) => (
        <p key={entry.id}>
          {formatDate(entry.effective_date)} — {entry.entry_type} — {entry.days > 0 ? `+${entry.days}` : entry.days}
        </p>
      ))}
    </div>
  );
}

function ContractsTab() {
  const [contracts, setContracts] = useState([]);

  useEffect(() => {
    api.getMyContracts().then((res) => setContracts(res.data));
  }, []);

  async function download(id, number) {
    const blob = await api.getMyContractBlob(id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${number}.pdf`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {contracts.length === 0 && <p>No finalized contracts yet.</p>}
      {contracts.map((c) => (
        <p key={c.id}>
          {c.contract_number} ({c.kind}) — {c.status}{" "}
          <Button variant="secondary" onClick={() => download(c.id, c.contract_number)}>
            Download
          </Button>
        </p>
      ))}
    </div>
  );
}
