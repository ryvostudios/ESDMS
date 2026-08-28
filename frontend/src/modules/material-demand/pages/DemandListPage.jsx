import { useState } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
import { useDemandList } from "../hooks/useDemandList.js";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { PermissionGate } from "../../../shared/components/PermissionGate.jsx";
import { DemandStatusBadge } from "../components/DemandStatusBadge.jsx";
import { formatDate } from "../../../shared/utilities/datetime.js";
import { MATERIAL_DEMAND_STATUSES } from "../constants.js";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import styles from "./DemandListPage.module.css";

const PAGE_SIZE = 20;

export function DemandListPage() {
  const navigate = useNavigate();
  // One-shot confirmation after an action that navigated here (deleting a
  // draft removes the record, so there is nothing left to show it on).
  const location = useLocation();
  const [flash] = useState(location.state?.flash ?? null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebouncedValue(search, 300);
  const { rows, total, status: loadStatus, error, reload } = useDemandList({
    status,
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div>
      <PageHeader
        title="Material Demands"
        description="Department material requests and their review status."
        actions={
          <PermissionGate permissions={["demand.create"]}>
            <Button onClick={() => navigate("/demands/new")}>New Demand</Button>
          </PermissionGate>
        }
      />

      {flash && (
        <p role="status" className={styles.flash}>
          {flash}
        </p>
      )}

      <div className={styles.filters}>
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search by Demand number"
          ariaLabel="Search Demands"
        />
        <Select
          className={styles.filterSelect}
          aria-label="Filter by status"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value);
            setPage(1);
          }}
        >
          <option value="">All statuses</option>
          {MATERIAL_DEMAND_STATUSES.map((value) => (
            <option key={value} value={value}>
              {formatEnumLabel(value)}
            </option>
          ))}
        </Select>
      </div>

      {loadStatus === "loading" && <LoadingState message="Loading Demands…" />}
      {loadStatus === "error" && <ErrorState message={error} onRetry={reload} />}
      {loadStatus === "ready" && rows.length === 0 && (
        <EmptyState title="No Demands found" message="Try adjusting your search or filters." />
      )}

      {loadStatus === "ready" && rows.length > 0 && (
        <>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Demand #</th>
                <th>Status</th>
                <th>Department</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((demand) => (
                <tr key={demand.id}>
                  <td>
                    <Link to={`/demands/${demand.id}`} className={styles.rowLink}>
                      {demand.demand_number}
                    </Link>
                  </td>
                  <td>
                    <DemandStatusBadge status={demand.status} />
                  </td>
                  <td>{demand.department_name}</td>
                  <td>{formatDate(demand.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <ul className={styles.cardList}>
            {rows.map((demand) => (
              <Link key={demand.id} to={`/demands/${demand.id}`} className={styles.card}>
                <div className={styles.cardHeader}>
                  <span>{demand.demand_number}</span>
                  <DemandStatusBadge status={demand.status} />
                </div>
                <div className={styles.cardMeta}>
                  <span>{demand.department_name}</span>
                  <span>{formatDate(demand.created_at)}</span>
                </div>
              </Link>
            ))}
          </ul>

          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
