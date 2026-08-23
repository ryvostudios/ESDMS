import { useEffect, useState, useCallback } from "react";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { ErrorState, LoadingState } from "../../../shared/components/StatePanel.jsx";
import * as api from "../api.js";

export function WorkforceOperationsPage() {
  const { hasPermission } = useAuth();
  const [leave, setLeave] = useState(null);
  const [documents, setDocuments] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => Promise.all([
    hasPermission("leave.approve") ? api.listPendingLeave() : Promise.resolve({ data: [] }),
    hasPermission("employee_documents.view") && hasPermission("workforce.reports.view") ? api.listExpiringDocuments(60) : Promise.resolve({ data: [] }),
  ]).then(([l, d]) => { setLeave(l.data); setDocuments(d.data); }).catch((e) => setError(e.message)), [hasPermission]);
  useEffect(() => { load(); }, [load]);
  async function decide(id, status) { try { await api.decideLeave(id, { status }); load(); } catch (e) { setError(e.message); } }
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!leave || !documents) return <LoadingState />;
  return <div><PageHeader title="Workforce Operations" description="Leave decisions and document expiry queues" />
    <section><h2>Pending leave</h2>{leave.length === 0 && <p>No pending requests.</p>}{leave.map((item) => <p key={item.id}>{item.employee_code} — {item.full_legal_name}: {item.start_date} to {item.end_date} <Button onClick={() => decide(item.id, "APPROVED")}>Approve</Button> <Button variant="danger" onClick={() => decide(item.id, "REJECTED")}>Reject</Button></p>)}</section>
    <section><h2>Documents expiring within 60 days</h2>{documents.length === 0 && <p>No matching documents.</p>}{documents.map((item) => <p key={item.id}>{item.employee_code} — {item.document_type_name}: {item.expiry_date}</p>)}</section>
  </div>;
}
