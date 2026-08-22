import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useGatePassList } from "../hooks/useGatePassList.js";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue.js";
import { GatePassStatusBadge } from "./GatePassStatusBadge.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { PermissionGate } from "../../../shared/components/PermissionGate.jsx";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { GATE_PASS_STATUSES } from "../constants.js";
import styles from "../pages/GatePassListPage.module.css";

const PAGE_SIZE = 20;

export function GatePassListView({ title, description, fixedStatus, showStatusFilter = true, showCreateAction = true }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState(fixedStatus || "");
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebouncedValue(search, 300);
  const { rows, total, status: loadStatus, error, reload } = useGatePassList({
    status: fixedStatus || status,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  function goToDetail(id) {
    navigate(`/gate-passes/${id}`);
  }

  return (
    <div>
      <PageHeader
        title={title}
        description={description}
        actions={
          showCreateAction && (
            <PermissionGate permissions={["gate_pass.create"]}>
              <Button onClick={() => navigate("/gate-passes/new")}>New Gate Pass</Button>
            </PermissionGate>
          )
        }
      />

      <div className={styles.filters}>
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search by number, vehicle, or driver"
          ariaLabel="Search Gate Passes"
        />
        {showStatusFilter && (
          <Select
            className={styles.statusSelect}
            aria-label="Filter by status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {GATE_PASS_STATUSES.map((value) => (
              <option key={value} value={value}>
                {formatEnumLabel(value)}
              </option>
            ))}
          </Select>
        )}
      </div>

      <div className={styles.card}>
        {loadStatus === "loading" && <LoadingState message="Loading Gate Passes…" />}
        {loadStatus === "error" && <ErrorState message={error} onRetry={reload} />}
        {loadStatus === "ready" && rows.length === 0 && (
          <EmptyState title="No Gate Passes found" message="Try adjusting your search or filters." />
        )}

        {loadStatus === "ready" && rows.length > 0 && (
          <>
            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Gate Pass #</th>
                    <th>Status</th>
                    <th>Destination</th>
                    <th>Vehicle</th>
                    <th>Driver</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((gatePass) => (
                    // The row's onClick is a mouse-convenience shortcut, not the
                    // only way in: the Gate Pass number below is a real link, so
                    // keyboard/screen-reader users have a genuine focusable target.
                    <tr key={gatePass.id} className={styles.row} onClick={() => goToDetail(gatePass.id)}>
                      <td className={styles.gatePassNumber}>
                        <Link to={`/gate-passes/${gatePass.id}`} className={styles.rowLink}>
                          {gatePass.gatePassNumber}
                        </Link>
                      </td>
                      <td>
                        <GatePassStatusBadge status={gatePass.status} />
                      </td>
                      <td>{gatePass.destination}</td>
                      <td>{gatePass.vehicleRegistration}</td>
                      <td>{gatePass.driverName}</td>
                      <td className={styles.muted}>{new Date(gatePass.createdAt).toLocaleDateString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className={styles.cardList}>
              {rows.map((gatePass) => (
                <Link key={gatePass.id} to={`/gate-passes/${gatePass.id}`} className={styles.mobileRow}>
                  <div className={styles.mobileRowTop}>
                    <span className={styles.gatePassNumber}>{gatePass.gatePassNumber}</span>
                    <GatePassStatusBadge status={gatePass.status} />
                  </div>
                  <div className={styles.mobileRowMeta}>
                    <span>{gatePass.destination}</span>
                    <span>
                      {gatePass.vehicleRegistration} · {gatePass.driverName}
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          </>
        )}
      </div>

      {loadStatus === "ready" && total > 0 && (
        <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
      )}
    </div>
  );
}
