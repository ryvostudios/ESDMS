import { useState } from "react";
import { Link } from "react-router-dom";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { useIpoList } from "../hooks/useIpoList.js";
import { IPO_STATUSES, IPO_STATUS_TONE } from "../constants.js";
import styles from "./IpoListPage.module.css";

const PAGE_SIZE = 20;

export function IpoListPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const { rows, total, status: loadState, error, reload } = useIpoList({
    search: debouncedSearch,
    status,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div>
      <PageHeader
        title="Internal Purchase Orders"
        description="Approved purchasing documents generated automatically from completed final approvals."
      />

      <div className={styles.filters}>
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search by IPO or Demand number"
          ariaLabel="Search IPOs"
        />
        <label className={styles.statusFilter}>
          <span>Status</span>
          <Select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {IPO_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {loadState === "loading" && <LoadingState message="Loading IPOs…" />}
      {loadState === "error" && <ErrorState message={error} onRetry={reload} />}
      {loadState === "ready" && rows.length === 0 && (
        <EmptyState
          title="No IPOs yet"
          message="An IPO is created automatically once a Demand completes its final approval."
        />
      )}
      {loadState === "ready" && rows.length > 0 && (
        <>
          <ul className={styles.list}>
            {rows.map((ipo) => (
              <li key={ipo.id}>
                <Link to={`/ipos/${ipo.id}`} className={styles.row}>
                  <div className={styles.identity}>
                    <strong>{ipo.ipo_number}</strong>
                    <span>
                      {ipo.department_name} · Demand {ipo.demand_number}
                    </span>
                  </div>
                  <div className={styles.meta}>
                    <StatusBadge
                      tone={IPO_STATUS_TONE[ipo.status]}
                      label={ipo.status.replaceAll("_", " ")}
                    />
                    <span>
                      {ipo.purchased_line_count} of {ipo.line_count} lines purchased
                    </span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
