import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { listGatePasses } from "../api.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { PermissionGate } from "../../../shared/components/PermissionGate.jsx";
import { MiniGatePassList } from "../components/MiniGatePassList.jsx";
import styles from "./DashboardPage.module.css";

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const canApprove = hasPermission("gate_pass.approve");

  const [state, setState] = useState({ status: "loading", recent: [], pending: [], error: null });

  useEffect(() => {
    let cancelled = false;

    const requests = [listGatePasses({ page: 1, pageSize: 5 })];
    if (canApprove) {
      requests.push(listGatePasses({ status: "PENDING_APPROVAL", page: 1, pageSize: 5 }));
    }

    Promise.all(requests)
      .then(([recentResponse, pendingResponse]) => {
        if (cancelled) return;
        setState({
          status: "ready",
          recent: recentResponse.data,
          pending: pendingResponse ? pendingResponse.data : [],
          error: null,
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setState((prev) => ({ ...prev, status: "error", error: error.message }));
      });

    return () => {
      cancelled = true;
    };
  }, [canApprove]);

  return (
    <div>
      <PageHeader
        title={`Welcome, ${user.fullName.split(" ")[0]}`}
        description="Gate Pass overview"
        actions={
          <PermissionGate permissions={["gate_pass.create"]}>
            <Button onClick={() => navigate("/gate-passes/new")}>New Gate Pass</Button>
          </PermissionGate>
        }
      />

      {state.status === "loading" && <LoadingState message="Loading dashboard…" />}
      {state.status === "error" && <ErrorState message={state.error} />}

      {state.status === "ready" && (
        <div className={styles.grid}>
          {canApprove && (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Pending your approval</h2>
                <Link className={styles.viewAll} to="/approvals">
                  View all
                </Link>
              </div>
              <MiniGatePassList rows={state.pending} emptyMessage="Nothing awaiting approval." />
            </div>
          )}

          <div className={styles.section}>
            <div className={styles.sectionHeader}>
              <h2 className={styles.sectionTitle}>Recent Gate Passes</h2>
              <Link className={styles.viewAll} to="/gate-passes">
                View all
              </Link>
            </div>
            <MiniGatePassList rows={state.recent} emptyMessage="No Gate Passes yet." />
          </div>
        </div>
      )}
    </div>
  );
}
