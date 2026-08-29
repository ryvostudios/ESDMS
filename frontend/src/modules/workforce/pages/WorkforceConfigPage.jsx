import { useCallback, useEffect, useState } from "react";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { ConfirmActionDialog } from "../../../shared/components/ConfirmActionDialog.jsx";
import * as api from "../api.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";

// Configuration primitives (Departments/Positions/Employment Types/Document
// Types/Rotation Policies/Leave Types) — gated by workforce.configuration.
// manage / departments.manage / positions.manage / employment_types.manage,
// each already independent server-side permissions. The deliberately plain
// controls still expose create and archive/reactivate lifecycle operations.
export function WorkforceConfigPage() {
  const { hasPermission } = useAuth();
  return (
    <div>
      <PageHeader title="Workforce Configuration" />
      {hasPermission("departments.manage") && <DepartmentsSection />}
      {hasPermission("positions.manage") && <PositionsSection />}
      {hasPermission("employment_types.manage") && <EmploymentTypesSection />}
      {hasPermission("workforce.configuration.manage") && <ProfileSectionsSection />}
      {hasPermission("workforce.configuration.manage") && <CustomFieldsSection />}
      {hasPermission("workforce.configuration.manage") && <DocumentTypesSection />}
      {hasPermission("rotation.manage") && <RotationPoliciesSection />}
      {hasPermission("leave.manage") && <LeaveTypesSection />}
    </div>
  );
}

function useCreateForm(list, create) {
  const [rows, setRows] = useState([]);
  const [name, setName] = useState("");
  const [message, setMessage] = useState(null);

  const load = () => list().then((r) => setRows(r.data));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCreate(extra = {}) {
    try {
      await create({ name, ...extra });
      setName("");
      setMessage(null);
      load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return { rows, name, setName, message, handleCreate, load };
}

function LifecycleActionButton({ entityName, isActive, onConfirm }) {
  const [open, setOpen] = useState(false);
  const action = isActive ? "Archive" : "Reactivate";
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>{action}</Button>
      <ConfirmActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`${action} ${entityName}?`}
        message={isActive
          ? `Archive ${entityName}? It will no longer be available for new assignments, but existing history is preserved.`
          : `Reactivate ${entityName}? It will be available for new assignments again.`}
        confirmLabel={action}
        variant={isActive ? "danger" : "primary"}
        onConfirm={onConfirm}
      />
    </>
  );
}

function DepartmentRow({ department, load }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(department.name);
  return (
    <p>
      {editing ? (
        <>
          <Input aria-label={`Department name for ${department.name}`} value={name} onChange={(event) => setName(event.target.value)} />{" "}
          <Button onClick={async () => { await api.updateDepartment(department.id, { name }); setEditing(false); load(); }}>Save</Button>{" "}
          <Button variant="secondary" onClick={() => { setName(department.name); setEditing(false); }}>Cancel</Button>
        </>
      ) : (
        <>
          {department.name} {department.is_active ? "" : "(archived)"}{" "}
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>{" "}
          <LifecycleActionButton
            entityName={`department “${department.name}”`}
            isActive={department.is_active}
            onConfirm={async () => { await api.archiveDepartment(department.id, !department.is_active); load(); }}
          />
        </>
      )}
    </p>
  );
}

function PositionRow({ position, load }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(position.name);
  return (
    <p>
      {editing ? (
        <>
          {position.code} — <Input aria-label={`Position name for ${position.code}`} value={name} onChange={(event) => setName(event.target.value)} />{" "}
          <Button onClick={async () => { await api.updatePosition(position.id, { name }); setEditing(false); load(); }}>Save</Button>{" "}
          <Button variant="secondary" onClick={() => { setName(position.name); setEditing(false); }}>Cancel</Button>
        </>
      ) : (
        <>
          {position.code} — {position.name} {position.is_active ? "" : "(archived)"}{" "}
          <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>{" "}
          <LifecycleActionButton
            entityName={`position “${position.name}”`}
            isActive={position.is_active}
            onConfirm={async () => { await api.updatePosition(position.id, { isActive: !position.is_active }); load(); }}
          />
        </>
      )}
    </p>
  );
}

function DepartmentsSection() {
  const { rows, name, setName, message, handleCreate, load } = useCreateForm(api.listDepartmentsManage, api.createDepartment);
  return (
    <section>
      <h2>Departments</h2>
      {message && <p role="alert">{message}</p>}
      {rows.map((d) => (
        <DepartmentRow key={d.id} department={d} load={load} />
      ))}
      <FormField label="New department name" htmlFor="deptName">
        <Input id="deptName" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <Button onClick={() => handleCreate()}>Add department</Button>
    </section>
  );
}

function PositionsSection() {
  const [rows, setRows] = useState([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [message, setMessage] = useState(null);

  const load = () => api.listPositionsManage().then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);

  async function handleCreate() {
    try {
      await api.createPosition({ code, name });
      setCode("");
      setName("");
      load();
    } catch (err) {
      setMessage(err.message);
    }
  }

  return (
    <section>
      <h2>Positions</h2>
      {message && <p role="alert">{message}</p>}
      {rows.map((p) => (
        <PositionRow key={p.id} position={p} load={load} />
      ))}
      <FormField label="Code" htmlFor="posCode">
        <Input id="posCode" value={code} onChange={(e) => setCode(e.target.value)} />
      </FormField>
      <FormField label="Name" htmlFor="posName">
        <Input id="posName" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <Button onClick={handleCreate}>Add position</Button>
    </section>
  );
}

function EmploymentTypesSection() {
  const [rows, setRows] = useState([]);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const load = () => api.listEmploymentTypesManage().then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);

  return (
    <section>
      <h2>Employment Types</h2>
      {rows.map((t) => (
        <p key={t.id}>
          {t.code} — {t.name} {t.is_active ? "" : "(archived)"}{" "}
          <LifecycleActionButton entityName={`employment type “${t.name}”`} isActive={t.is_active} onConfirm={async () => { await api.updateEmploymentType(t.id, { isActive: !t.is_active }); load(); }} />
        </p>
      ))}
      <FormField label="Code" htmlFor="etCode">
        <Input id="etCode" value={code} onChange={(e) => setCode(e.target.value)} />
      </FormField>
      <FormField label="Name" htmlFor="etName">
        <Input id="etName" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <Button
        onClick={async () => {
          await api.createEmploymentType({ code, name });
          setCode("");
          setName("");
          load();
        }}
      >
        Add employment type
      </Button>
    </section>
  );
}

function DocumentTypesSection() {
  const { rows, name, setName, message, handleCreate, load } = useCreateForm(api.listDocumentTypesManage, api.createDocumentType);
  return (
    <section>
      <h2>Document Types</h2>
      {message && <p role="alert">{message}</p>}
      {rows.map((d) => (
        <p key={d.id}>{d.name} {d.is_required ? "· required" : ""} {d.is_active === false ? "· archived" : ""} <LifecycleActionButton entityName={`document type “${d.name}”`} isActive={d.is_active !== false} onConfirm={async () => { await api.updateDocumentType(d.id, { isActive: d.is_active === false }); load(); }} /></p>
      ))}
      <FormField label="New document type name" htmlFor="docTypeName">
        <Input id="docTypeName" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <Button onClick={() => handleCreate({ allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"] })}>
        Add document type
      </Button>
    </section>
  );
}

function ProfileSectionsSection() {
  const { rows, name, setName, message, handleCreate, load } = useCreateForm(api.listProfileSections, api.createProfileSection);
  return <section><h2>Profile Sections</h2>{message && <p role="alert">{message}</p>}{rows.map((section) => <p key={section.id}>{section.name} {section.is_active ? "" : "(archived)"} <LifecycleActionButton entityName={`profile section “${section.name}”`} isActive={section.is_active} onConfirm={async () => { await api.updateProfileSection(section.id, { isActive: !section.is_active }); load(); }} /></p>)}<FormField label="New section name" htmlFor="profileSectionName"><Input id="profileSectionName" value={name} onChange={(e) => setName(e.target.value)} /></FormField><Button onClick={() => handleCreate()}>Add section</Button></section>;
}

function CustomFieldsSection() {
  const [sections, setSections] = useState([]);
  const [rows, setRows] = useState([]);
  const [sectionId, setSectionId] = useState("");
  const [label, setLabel] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [fieldType, setFieldType] = useState("TEXT");
  const [message, setMessage] = useState(null);
  const load = useCallback(async () => { const [sectionResult, fieldResult] = await Promise.all([api.listProfileSections(), api.listCustomFieldsManage()]); setSections(sectionResult.data); setRows(fieldResult.data); if (sectionResult.data[0]) setSectionId((current) => current || sectionResult.data[0].id); }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);
  async function create(event) { event.preventDefault(); try { await api.createCustomField({ sectionId, label, fieldKey, fieldType, employeeCanView: true, employeeCanEdit: true, hrCanView: true, hrCanEdit: true }); setLabel(""); setFieldKey(""); load(); } catch (error) { setMessage(error.message); } }
  return <section><h2>Custom Fields</h2>{message && <p role="alert">{message}</p>}{rows.map((field) => <p key={field.id}>{field.label} ({field.field_key}, {field.field_type}) {field.is_active ? "" : "· archived"} <LifecycleActionButton entityName={`custom field “${field.label}”`} isActive={field.is_active} onConfirm={async () => { await api.updateCustomField(field.id, { isActive: !field.is_active }); load(); }} /></p>)}<form onSubmit={create}><FormField label="Section" htmlFor="fieldSection"><Select id="fieldSection" value={sectionId} onChange={(e) => setSectionId(e.target.value)}>{sections.filter((section) => section.is_active).map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</Select></FormField><FormField label="Label" htmlFor="fieldLabel"><Input id="fieldLabel" value={label} onChange={(e) => setLabel(e.target.value)} required /></FormField><FormField label="Field key" htmlFor="fieldKey"><Input id="fieldKey" value={fieldKey} onChange={(e) => setFieldKey(e.target.value)} placeholder="lowercase_snake_case" required /></FormField><FormField label="Type" htmlFor="fieldType"><Select id="fieldType" value={fieldType} onChange={(e) => setFieldType(e.target.value)}>{["TEXT","LONG_TEXT","NUMBER","DATE","BOOLEAN","DROPDOWN","MULTI_SELECT","EMAIL","PHONE","URL","PERCENTAGE"].map((type) => <option key={type}>{type}</option>)}</Select></FormField><Button type="submit">Add custom field</Button></form></section>;
}

function RotationPoliciesSection() {
  const [rows, setRows] = useState([]);
  const [name, setName] = useState("");
  const [workDays, setWorkDays] = useState(22);
  const [offDays, setOffDays] = useState(8);

  const load = () => api.listRotationPolicies().then((r) => setRows(r.data));
  useEffect(() => {
    load();
  }, []);

  return (
    <section>
      <h2>Rotation Policies</h2>
      {rows.map((p) => (
        <p key={p.id}>
          {p.name} — {p.work_days}/{p.off_days} {p.is_active ? "" : "(archived)"}{" "}
          <LifecycleActionButton entityName={`rotation policy “${p.name}”`} isActive={p.is_active} onConfirm={async () => { await api.updateRotationPolicy(p.id, { isActive: !p.is_active }); load(); }} />
        </p>
      ))}
      <FormField label="Name" htmlFor="rpName">
        <Input id="rpName" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <FormField label="Work days" htmlFor="rpWork">
        <Input id="rpWork" type="number" value={workDays} onChange={(e) => setWorkDays(e.target.value)} />
      </FormField>
      <FormField label="Off days" htmlFor="rpOff">
        <Input id="rpOff" type="number" value={offDays} onChange={(e) => setOffDays(e.target.value)} />
      </FormField>
      <Button
        onClick={async () => {
          await api.createRotationPolicy({ name, workDays: Number(workDays), offDays: Number(offDays) });
          setName("");
          load();
        }}
      >
        Add policy
      </Button>
    </section>
  );
}

function LeaveTypesSection() {
  const { rows, name, setName, message, handleCreate, load } = useCreateForm(api.listLeaveTypes, api.createLeaveType);
  return (
    <section>
      <h2>Leave Types</h2>
      {message && <p role="alert">{message}</p>}
      {rows.map((t) => (
        <p key={t.id}>{t.name} {t.is_active ? "" : "(archived)"} <LifecycleActionButton entityName={`leave type “${t.name}”`} isActive={t.is_active} onConfirm={async () => { await api.updateLeaveType(t.id, { isActive: !t.is_active }); load(); }} /></p>
      ))}
      <FormField label="New leave type name" htmlFor="leaveTypeName">
        <Input id="leaveTypeName" value={name} onChange={(e) => setName(e.target.value)} />
      </FormField>
      <Button onClick={() => handleCreate()}>Add leave type</Button>
    </section>
  );
}
