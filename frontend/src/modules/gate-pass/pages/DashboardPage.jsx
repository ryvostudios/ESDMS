import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { listGatePasses } from "../api.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { PermissionGate } from "../../../shared/components/PermissionGate.jsx";
import { KpiCard } from "../../../shared/components/KpiCard.jsx";
import { BarList } from "../../../shared/components/BarList.jsx";
import { TruckIcon, ClipboardCheckIcon, BellIcon } from "../../../shared/icons.jsx";
import { MiniGatePassList } from "../components/MiniGatePassList.jsx";
import { GATE_PASS_STATUSES } from "../constants.js";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import styles from "./DashboardPage.module.css";

// Bar tone mirrors GatePassStatusBadge's STATUS_TONE, mapped onto BarList's
// smaller tone set.
const BAR_TONE = {
  DRAFT: "neutral",
  PENDING_APPROVAL: "warning",
  APPROVED: "info",
  VEHICLE_OUTSIDE: "info",
  COMPLETED: "success",
  REJECTED: "danger",
  CANCELLED: "danger",
};

export function DashboardPage() {
  const { user, hasPermission } = useAuth();
  const navigate = useNavigate();
  const canApprove = hasPermission("gate_pass.approve");

  const [state, setState] = useState({ status: "loading", recent: [], pending: [], counts: {}, total: 0, error: null });

  useEffect(() => {
    let cancelled = false;

    const statusRequests = GATE_PASS_STATUSES.map((status) => listGatePasses({ status, page: 1, pageSize: 1 }));
    const requests = [
      listGatePasses({ page: 1, pageSize: 5 }),
      listGatePasses({ page: 1, pageSize: 1 }),
      ...statusRequests,
    ];
    if (canApprove) {
      requests.push(listGatePasses({ status: "PENDING_APPROVAL", page: 1, pageSize: 5 }));
    }

    Promise.all(requests)
      .then((responses) => {
        if (cancelled) return;
        const [recentResponse, totalResponse, ...rest] = responses;
        const statusResponses = rest.slice(0, GATE_PASS_STATUSES.length);
        const pendingResponse = canApprove ? rest[GATE_PASS_STATUSES.length] : null;

        const counts = {};
        GATE_PASS_STATUSES.forEach((status, index) => {
          counts[status] = statusResponses[index].meta.total;
        });

        setState({
          status: "ready",
          recent: recentResponse.data,
          pending: pendingResponse ? pendingResponse.data : [],
          counts,
          total: totalResponse.meta.total,
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

  const isEmpty = state.status === "ready" && state.total === 0;

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

      {isEmpty && (
        <div className={styles.section}>
          {/* "New Gate Pass" is already the PageHeader's own action above —
              not duplicated here. */}
          <EmptyState
            title="No Gate Passes yet"
            message="Once Gate Passes are created for your site, they'll show up here."
          />
        </div>
      )}

      {state.status === "ready" && !isEmpty && (
        <>
          <div className={styles.kpiGrid}>
            <KpiCard icon={TruckIcon} label="Gate Passes in scope" value={state.total} />
            <KpiCard
              icon={ClipboardCheckIcon}
              label="Pending approval"
              value={state.counts.PENDING_APPROVAL ?? 0}
              tone="warning"
            />
            <KpiCard icon={TruckIcon} label="Vehicles outside" value={state.counts.VEHICLE_OUTSIDE ?? 0} tone="info" />
            <KpiCard icon={BellIcon} label="Completed" value={state.counts.COMPLETED ?? 0} tone="success" />
          </div>

          <div className={styles.grid}>
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                <h2 className={styles.sectionTitle}>Status distribution</h2>
              </div>
              <BarList
                items={GATE_PASS_STATUSES.map((status) => ({
                  label: formatEnumLabel(status),
                  value: state.counts[status] ?? 0,
                  tone: BAR_TONE[status],
                }))}
              />
            </div>

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
        </>
      )}
    </div>
  );
}
