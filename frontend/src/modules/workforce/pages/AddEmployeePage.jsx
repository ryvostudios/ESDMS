import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "../../../core/api/client.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import styles from "./AddEmployeePage.module.css";
import * as api from "../api.js";

// No role field anywhere on this form — HR creating a login always gets
// EMPLOYEE (backend-enforced, see employees.service.js's
// createLoginForEmployee). This page has no way to even attempt a
// privileged role.
export function AddEmployeePage() {
  const navigate = useNavigate();
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState("");
  const [departments, setDepartments] = useState([]);
  const [positions, setPositions] = useState([]);
  const [employmentTypes, setEmploymentTypes] = useState([]);

  const [employeeCode, setEmployeeCode] = useState("");
  const [fullLegalName, setFullLegalName] = useState("");
  const [joiningDate, setJoiningDate] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [positionId, setPositionId] = useState("");
  const [employmentTypeId, setEmploymentTypeId] = useState("");

  // { matches: [...authorized detail...], outsideScopeMatch: boolean } —
  // see employees.service.js's buildDuplicateCheckResult (ESDMS-002). An
  // out-of-scope match is never an individual row, even a redacted one —
  // only this one boolean, so the count of such matches is never exposed.
  const [duplicateResult, setDuplicateResult] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // Site-first: a site-scoped actor gets exactly one site back and it's
  // auto-selected (no selector shown); an all-site actor sees every active
  // site and must choose before Department/Position become available.
  useEffect(() => {
    api.listSites().then((r) => {
      setSites(r.data);
      if (r.data.length === 1) setSiteId(r.data[0].id);
    });
    api.listEmploymentTypes().then((r) => setEmploymentTypes(r.data));
  }, []);

  // Fetches the active Department/Position catalog for the current target
  // site (including the initial auto-selected one) — nothing to fetch, and
  // nothing to synchronize, until a site exists. Clearing an incompatible
  // Department/Position choice happens in changeSite below, event-driven
  // off the Site selector itself, not derived here: both selects are also
  // `disabled={!siteId}`, so stale catalog entries from a site the actor
  // has since moved away from are never selectable while there's no site.
  useEffect(() => {
    if (!siteId) return;
    api.listDepartments(siteId).then((r) => setDepartments(r.data));
    api.listPositions(siteId).then((r) => setPositions(r.data));
  }, [siteId]);

  function changeSite(nextSiteId) {
    setSiteId(nextSiteId);
    // A Department/Position chosen under the previous site is not
    // necessarily valid (or even the same row id) under the new one.
    setDepartmentId("");
    setPositionId("");
  }

  async function createNow(confirmDuplicateOverride) {
    setSubmitting(true);
    setError(null);
    try {
      const response = await api.createEmployee({
        employeeCode,
        fullLegalName,
        joiningDate,
        siteId: siteId || undefined,
        departmentId: departmentId || undefined,
        positionId: positionId || undefined,
        employmentTypeId: employmentTypeId || undefined,
        confirmDuplicateOverride,
      });
      navigate(`/workforce/employees/${response.data.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.details?.matches) {
        setDuplicateResult(err.details);
      } else {
        setError(err instanceof ApiError ? err.message : "Unable to create employee.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  const fixedSite = sites.length === 1 ? sites[0] : null;

  return (
    <div>
      <PageHeader title="Add Employee" description="Create a new Employee record and, optionally, their initial assignment." />
      {error && <p role="alert">{error}</p>}

      {duplicateResult && (
        <div className={styles.duplicatePanel} role="alert">
          <p className={styles.duplicateTitle}>Possible duplicate Employee(s) found</p>
          <p className={styles.duplicateHint}>
            Review the matches below before creating a new record for the same person.
          </p>

          {duplicateResult.matches.length > 0 && (
            <ul className={styles.matchList}>
              {duplicateResult.matches.map((d) => (
                <li key={d.id} className={styles.matchRow}>
                  <span className={styles.matchCode}>{d.employee_code}</span>
                  <span>{d.full_legal_name}</span>
                </li>
              ))}
            </ul>
          )}

          {duplicateResult.outsideScopeMatch && (
            <div className={styles.outsideScopeNotice}>
              <span className={styles.outsideScopeIcon} aria-hidden="true">
                !
              </span>
              <p>A possible matching Employee exists outside your access scope.</p>
            </div>
          )}

          <div className={styles.actions}>
            <Button onClick={() => createNow(true)} loading={submitting}>
              Create anyway
            </Button>
            <Button variant="secondary" onClick={() => setDuplicateResult(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {!duplicateResult && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            createNow(false);
          }}
        >
          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Employment identity</h2>
            <div className={styles.grid}>
              <FormField label="Employee ID" htmlFor="employeeCode" required>
                <Input id="employeeCode" value={employeeCode} onChange={(e) => setEmployeeCode(e.target.value)} required />
              </FormField>
              <FormField label="Full legal name" htmlFor="fullLegalName" required>
                <Input id="fullLegalName" value={fullLegalName} onChange={(e) => setFullLegalName(e.target.value)} required />
              </FormField>
              <FormField label="Joining date" htmlFor="joiningDate" required>
                <Input id="joiningDate" type="date" value={joiningDate} onChange={(e) => setJoiningDate(e.target.value)} required />
              </FormField>
            </div>
          </div>

          <div className={styles.section}>
            <h2 className={styles.sectionTitle}>Organization / assignment</h2>

            {sites.length > 1 && (
              <FormField
                label="Site"
                htmlFor="siteId"
                required
                hint={!siteId ? "Select a site to enable Department and Position below." : undefined}
              >
                <Select id="siteId" value={siteId} onChange={(e) => changeSite(e.target.value)} required>
                  <option value="">— Select a site —</option>
                  {sites.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            )}

            {fixedSite && (
              <p className={styles.siteContext}>
                Site <span className={styles.siteContextValue}>{fixedSite.name}</span>
              </p>
            )}

            <div className={styles.grid}>
              <FormField
                label="Department"
                htmlFor="departmentId"
                hint={!siteId ? "Choose a site first." : undefined}
              >
                <Select id="departmentId" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} disabled={!siteId}>
                  <option value="">—</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </FormField>
              <FormField
                label="Position"
                htmlFor="positionId"
                hint={!siteId ? "Choose a site first." : undefined}
              >
                <Select id="positionId" value={positionId} onChange={(e) => setPositionId(e.target.value)} disabled={!siteId}>
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
            </div>
          </div>

          <div className={styles.actions}>
            <Button type="submit" loading={submitting}>
              Create Employee
            </Button>
            <Button type="button" variant="secondary" onClick={() => navigate("/workforce/employees")}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
