import { useEffect, useState } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { LoadingState } from "../../../shared/components/StatePanel.jsx";
import * as api from "../api.js";

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}

export function WorkforceReportsPage() {
  const { hasPermission } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [reportKey, setReportKey] = useState("employee-master");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [message, setMessage] = useState(null);
  useEffect(() => { api.getReportCatalog().then((r) => { setCatalog(r.data); if (r.data[0]) setReportKey(r.data[0].key); }).catch((e) => setMessage(e.message)); }, []);
  if (!catalog && !message) return <LoadingState />;
  async function downloadReport() {
    try { saveBlob(await api.downloadWorkforceReport(reportKey, { ...(from && { from }), ...(to && { to }) }), `${reportKey}.xlsx`); }
    catch (error) { setMessage(error.message); }
  }
  async function template() { saveBlob(await api.downloadImportTemplate(), "Employee_Import_Template.xlsx"); }
  async function runPreview() {
    if (!file) return;
    const form = new FormData(); form.append("file", file);
    try { setPreview((await api.previewEmployeeImport(form)).data); setMessage(null); } catch (error) { setMessage(error.message); }
  }
  async function confirmImport() {
    const form = new FormData(); form.append("file", file); form.append("confirmationToken", preview.confirmationToken); form.append("confirmWarnings", "true");
    try { const result = await api.confirmEmployeeImport(form); setMessage(`${result.data.importedCount} employees imported.`); setPreview(null); setFile(null); }
    catch (error) { setMessage(error.message); }
  }
  async function bulkExport() {
    try { saveBlob(await api.downloadBulkFiles({ includeContracts: hasPermission("contract.download") }), "Workforce_Export.zip"); }
    catch (error) { setMessage(error.message); }
  }
  return <div>
    <PageHeader title="Workforce Reports" description="Server-authorized XLSX and private file exports" />
    {message && <p role={message.includes("imported") ? "status" : "alert"}>{message}</p>}
    <section>
      <h2>Report catalog</h2>
      <FormField label="Report" htmlFor="report"><Select id="report" value={reportKey} onChange={(e) => setReportKey(e.target.value)}>{catalog?.map((item) => <option key={item.key} value={item.key}>{item.name}</option>)}</Select></FormField>
      <FormField label="From" htmlFor="reportFrom"><Input id="reportFrom" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></FormField>
      <FormField label="To" htmlFor="reportTo"><Input id="reportTo" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></FormField>
      <Button onClick={downloadReport}>Download XLSX</Button>
    </section>
    {hasPermission("employees.bulk_import") && <section>
      <h2>Bulk employee import</h2>
      <Button variant="secondary" onClick={template}>Download template</Button>
      <FormField label="Completed template" htmlFor="importFile"><input id="importFile" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); }} /></FormField>
      <Button onClick={runPreview} disabled={!file}>Validate and preview</Button>
      {preview && <div>
        <p>{preview.rowCount} rows · {preview.errors.length} errors · {preview.warnings.length} warnings</p>
        {preview.errors.map((row) => <p key={`e-${row.rowNumber}`} role="alert">Row {row.rowNumber}: {row.errors.join(" ")}</p>)}
        {preview.warnings.map((row, index) => <p key={`w-${row.rowNumber}-${index}`}>Row {row.rowNumber}: {row.message}</p>)}
        {preview.confirmationToken && <Button onClick={confirmImport}>Confirm transactional import</Button>}
      </div>}
    </section>}
    {hasPermission("employee_documents.bulk_export") && <section><h2>Bulk private files</h2><p>Limited to the employees and files in your current server-side scope.</p><Button onClick={bulkExport}>Download ZIP</Button></section>}
  </div>;
}
