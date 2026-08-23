import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import * as api from "../api.js";

// No role field anywhere on this form — HR creating a login always gets
// EMPLOYEE (backend-enforced, see employees.service.js's
// createLoginForEmployee). This page has no way to even attempt a
// privileged role.
export function AddEmployeePage() {
  const navigate = useNavigate();
  const [departments, setDepartments] = useState([]);
  const [positions, setPositions] = useState([]);
  const [employmentTypes, setEmploymentTypes] = useState([]);

  const [employeeCode, setEmployeeCode] = useState("");
  const [fullLegalName, setFullLegalName] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [employmentTypeId, setEmploymentTypeId] = useState("");

  const [duplicates, setDuplicates] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.listDepartmentsManage().then((r) => setDepartments(r.data));
    api.listPositions().then((r) => setPositions(r.data));
    api.listEmploymentTypes().then((r) => setEmploymentTypes(r.data));
  }, []);

  async function createNow(confirmDuplicateOverride) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.createEmployee({
        employeeCode,
        fullLegalName,
        joiningDate,
        departmentId: departmentId || undefined,
        positionId: positionId || undefined,
        employmentTypeId: employmentTypeId || undefined,
        confirmDuplicateOverride,
      });
      navigate(`/workforce/employees/${response.data.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details?.duplicates) {
        setDuplicates(err.details.duplicates);
      } else {
        setError(err instanceof ApiError ? err.message : "Unable to create employee.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <PageHeader title="Add Employee" />
      {error && <p role="alert">{error}</p>}

      {duplicates && (
        <div role="alert">
          <p>Possible duplicate employee(s) found:</p>
          {duplicates.map((d) => (
            <p key={d.id}>
              {d.employee_code} — {d.full_legal_name}
            </p>
          ))}
          <Button onClick={() => createNow(true)} loading={submitting}>
            Create anyway
          </Button>
          <Button variant="secondary" onClick={() => setDuplicates(null)}>
            Cancel
          </Button>
        </div>
      )}

      {!duplicates && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createNow(false);
          }}
        >
          <FormField label="Employee ID" htmlFor="employeeCode" required>
            <Input id="employeeCode" value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} required />
          </FormField>
          <FormField label="Full legal name" htmlFor="fullLegalName" required>
            <Input id="fullLegalName" value={fullLegalName} onChange={(e) => setFullLegalName(e.target.value)} required />
          </FormField>
          <FormField label="Joining date" htmlFor="joiningDate" required>
            <Input id="joiningDate" type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} required />
          </FormField>
          <FormField label="Department" htmlFor="departmentId">
            <Select id="departmentId" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
              <option value="">—</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Position" htmlFor="positionId">
            <Select id="positionId" value={positionId} onChange={(e) => setPositionId(e.target.value)}>
              <option value="">—</option>
              {positions.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Employment type" htmlFor="employmentTypeId">
            <Select id="employmentTypeId" value={employmentTypeId} onChange={(e) => setEmploymentTypeId(e.target.value)}>
              <option value="">—</option>
              {employmentTypes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </FormField>
          <Button type="submit" loading={submitting}>
            Create Employee
          </Button>
        </form>
      )}
    </div>
  );
}
