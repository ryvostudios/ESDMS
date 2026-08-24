import { useEffect, useState, useCallback } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { ApiError } from "../../../core/api/client.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Textarea, Select } from "../../../shared/components/FormField.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { formatDate } from "../../../shared/utilities/datetime.js";
import styles from "./MyWorkforcePage.module.css";
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

// Generic status → badge tone mapping, presentation-only: unrecognized
// statuses (any workflow value we don't specifically call out) fall back to
// neutral rather than guessing.
function statusTone(status) {
  if (["APPROVED", "VERIFIED", "ACTIVE"].includes(status)) return "success";
  if (["REJECTED", "EXPIRED"].includes(status)) return "danger";
  if (["SUBMITTED", "PENDING", "DRAFT"].includes(status)) return "info";
  if (status === "CANCELLED") return "neutral";
  return "neutral";
}

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

      <div className={styles.tabScroller}>
        <nav className={styles.tabList}>
          {availableTabs.map((t) => (
            <Button key={t} variant={tab === t ? "primary" : "secondary"} onClick={() => setTab(t)}>
              {t}
            </Button>
          ))}
        </nav>
      </div>

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
      <div className={styles.identityRow}>
        <h2 className={styles.identityName}>{profile.employee.full_legal_name}</h2>
        <span className={styles.identityMeta}>{profile.employee.employee_code}</span>
        <StatusBadge tone={statusTone(profile.employee.status)} label={profile.employee.status} />
      </div>

      {message && <p role="status" className={styles.statusMessage}>{message}</p>}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Personal details</h3>
        <FormField label="Profile photo" htmlFor="photo">
          <input id="photo" type="file" accept="image/jpeg,image/png,image/webp" onChange={handlePhotoChange} />
        </FormField>

        <form onSubmit={savePersonalDetails}>
          <div className={styles.grid}>
            <FormField label="Mobile" htmlFor="mobile">
              <Input id="mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} disabled={saving} />
            </FormField>
            <FormField label="CNIC" htmlFor="cnic">
              <Input id="cnic" value={cnic} onChange={(e) => setCnic(e.target.value)} disabled={saving} />
            </FormField>
            <FormField label="Personal email" htmlFor="personalEmail">
              <Input id="personalEmail" type="email" value={personalEmail} onChange={(e) => setPersonalEmail(e.target.value)} disabled={saving} />
            </FormField>
            <FormField label="Address" htmlFor="address">
              <Textarea id="address" value={address} onChange={(e) => setAddress(e.target.value)} disabled={saving} />
            </FormField>
          </div>
          <div className={styles.formActions}>
            <Button type="submit" loading={saving}>
              Save
            </Button>
          </div>
        </form>

        {profile.completion.missingCoreFields.length > 0 && (
          <p className={styles.missingNote}>Missing: {profile.completion.missingCoreFields.join(", ")}</p>
        )}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Emergency contacts</h3>
        {profile.emergencyContacts.length === 0 && <p className={styles.emptyText}>No emergency contacts on file.</p>}
        <ul className={styles.list}>
          {profile.emergencyContacts.map((contact) => (
            <li key={contact.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{contact.name}</span>
                <span className={styles.rowMeta}>{contact.phone}</span>
              </span>
              <span className={styles.rowActions}>
                <Button variant="secondary" onClick={async () => { await api.removeMyEmergencyContact(contact.id); onChanged(); }}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <form onSubmit={addContact} className={styles.formActions} style={{ marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <FormField label="Contact name" htmlFor="contactName"><Input id="contactName" value={contactName} onChange={(e) => setContactName(e.target.value)} required /></FormField>
          <FormField label="Contact phone" htmlFor="contactPhone"><Input id="contactPhone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} required /></FormField>
          <Button type="submit">Add emergency contact</Button>
        </form>
      </div>

      {fields.length > 0 && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Additional information</h3>
          <div className={styles.grid}>
            {fields.map((field) => (
              <div key={field.id}>
                <FormField label={field.label} htmlFor={`field-${field.id}`}>
                  <Input
                    id={`field-${field.id}`}
                    value={String(fieldValues[field.id] ?? "")}
                    disabled={!field.employee_can_edit}
                    onChange={(e) => setFieldValues((current) => ({ ...current, [field.id]: e.target.value }))}
                  />
                </FormField>
                {field.employee_can_edit && (
                  <Button variant="secondary" onClick={() => saveField(field)}>
                    Save field
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
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
        <div className={styles.section} role="status">
          <h3 className={styles.sectionTitle}>Pending actions</h3>
          <ul className={styles.list}>
            {requests.map((r) => (
              <li key={r.id} className={styles.row}>
                <span className={styles.rowTitle}>Please upload: {r.document_type_name}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>My documents</h3>

        {types.length > 0 && (
          <form onSubmit={upload} className={styles.grid}>
            <FormField label="Document type" htmlFor="myDocumentType">
              <Select id="myDocumentType" value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}>
                {types.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </Select>
            </FormField>
            <FormField label="Expiry date (when applicable)" htmlFor="myDocumentExpiry">
              <Input id="myDocumentExpiry" type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
            </FormField>
            <FormField label="File" htmlFor="myDocumentFile">
              <input id="myDocumentFile" type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] || null)} required />
            </FormField>
            <div className={styles.formActions}>
              <Button type="submit" disabled={!file}>Upload new version</Button>
            </div>
          </form>
        )}

        {documents.length === 0 && <p className={styles.emptyText}>No documents uploaded yet.</p>}
        <ul className={styles.list}>
          {documents.map((d) => (
            <li key={d.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{d.document_type_name}</span>
                <span className={styles.rowMeta}>Version {d.version}</span>
              </span>
              <StatusBadge tone={statusTone(d.verification_status)} label={d.verification_status} />
              <span className={styles.rowActions}>
                <Button variant="secondary" onClick={() => download(d)}>Download</Button>
              </span>
            </li>
          ))}
        </ul>
      </div>
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
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Apply for leave</h3>
        {message && <p role="status" className={styles.statusMessage}>{message}</p>}
        <form onSubmit={handleSubmit}>
          <div className={styles.grid}>
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
          </div>
          <div className={styles.formActions}>
            <Button type="submit">Submit</Button>
          </div>
        </form>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>My requests</h3>
        {requests.length === 0 && <p className={styles.emptyText}>No leave requests yet.</p>}
        <ul className={styles.list}>
          {requests.map((r) => (
            <li key={r.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{r.leave_type_name}</span>
                <span className={styles.rowMeta}>
                  {formatDate(r.start_date)} – {formatDate(r.end_date)}
                </span>
              </span>
              <StatusBadge tone={statusTone(r.status)} label={r.status} />
              {r.status === "SUBMITTED" && hasPermission("leave.self.cancel") && (
                <span className={styles.rowActions}>
                  <Button variant="danger" onClick={async () => { await api.cancelMyLeave(r.id); load(); }}>
                    Cancel
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MyCompensationTab() {
  const [current, setCurrent] = useState(undefined);
  useEffect(() => { api.getMyCompensation().then((result) => setCurrent(result.data)).catch(() => setCurrent(null)); }, []);
  if (current === undefined) return <LoadingState />;
  return (
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>My current compensation</h3>
      {current ? (
        <p className={styles.compensationValue}>
          {current.amount} {current.currency}
          <span className={styles.rowMeta}> · effective {formatDate(current.effective_date)}</span>
        </p>
      ) : (
        <p className={styles.emptyText}>No current compensation record.</p>
      )}
    </div>
  );
}

function RotationTab() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.getMyRotation().then((res) => setStatus(res.data));
  }, []);

  if (!status) return <LoadingState />;

  return (
    <div>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Rotation status</h3>
        <p className={styles.rowMeta}>Policy: {status.policy ? `${status.policy.name} (${status.policy.work_days}/${status.policy.off_days})` : "Not assigned"}</p>
        <p className={styles.rowMeta}>Off-day balance: {status.balance}</p>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>History</h3>
        {status.ledger.length === 0 && <p className={styles.emptyText}>No rotation history yet.</p>}
        <ul className={styles.list}>
          {status.ledger.map((entry) => (
            <li key={entry.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowTitle}>{entry.entry_type}</span>
                <span className={styles.rowMeta}>{formatDate(entry.effective_date)}</span>
              </span>
              <span className={styles.rowTitle}>{entry.days > 0 ? `+${entry.days}` : entry.days}</span>
            </li>
          ))}
        </ul>
      </div>
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
    <div className={styles.section}>
      <h3 className={styles.sectionTitle}>My contracts</h3>
      {contracts.length === 0 && <p className={styles.emptyText}>No finalized contracts yet.</p>}
      <ul className={styles.list}>
        {contracts.map((c) => (
          <li key={c.id} className={styles.row}>
            <span className={styles.rowMain}>
              <span className={styles.rowTitle}>{c.contract_number}</span>
              <span className={styles.rowMeta}>{c.kind}</span>
            </span>
            <StatusBadge tone={statusTone(c.status)} label={c.status} />
            <span className={styles.rowActions}>
              <Button variant="secondary" onClick={() => download(c.id, c.contract_number)}>
                Download
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
