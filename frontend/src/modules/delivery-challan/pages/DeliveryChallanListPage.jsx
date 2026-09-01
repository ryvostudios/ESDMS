import { useState } from "react";
import { Link } from "react-router-dom";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Select } from "../../../shared/components/FormField.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { DC_STATUS_TONE } from "../../ipo/constants.js";
import { useDeliveryChallanList } from "../hooks/useDeliveryChallanList.js";
import styles from "./DeliveryChallanListPage.module.css";

// A Delivery Challan was only ever reachable by navigating into its IPO, so
// "which challans are open right now?" could not be answered without walking
// IPO by IPO — even though the backend has always had a filtered, paginated
// list endpoint. Same shape as the IPO list deliberately: the two are read
// side by side.
//
// Delivery Challan stays a separate concept from Gate Pass. This lists the
// commercial delivery document; vehicle movement through the gate is its own
// module and is not mixed in here.
const PAGE_SIZE = 20;

const STATUSES = ["DRAFT", "FINALIZED", "RECEIVING", "COMPLETED", "CANCELLED"];

export function DeliveryChallanListPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);

  const { rows, total, status: loadState, error, reload } = useDeliveryChallanList({
    search: debouncedSearch,
    status,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div>
      <PageHeader
        title="Delivery Challans"
        description="Delivery documents issued against purchased IPO lines, and where each one has reached."
      />

      <div className={styles.filters}>
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search by Challan or IPO number"
          ariaLabel="Search Delivery Challans"
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
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </label>
      </div>

      {loadState === "loading" && <LoadingState message="Loading Delivery Challans…" />}
      {loadState === "error" && <ErrorState message={error} onRetry={reload} />}
      {loadState === "ready" && rows.length === 0 && (
        <EmptyState
          title="No Delivery Challans"
          message="A Challan is created from an IPO once its lines have been purchased."
        />
      )}
      {loadState === "ready" && rows.length > 0 && (
        <>
          <ul className={styles.list}>
            {rows.map((challan) => (
              <li key={challan.id}>
                <Link to={`/delivery-challans/${challan.id}`} className={styles.row}>
                  <div className={styles.identity}>
                    <strong>{challan.dc_number}</strong>
                    <span>
                      {challan.department_name} · IPO {challan.ipo_number}
                    </span>
                  </div>
                  <div className={styles.meta}>
                    <StatusBadge
                      tone={DC_STATUS_TONE[challan.status]}
                      label={challan.status.replaceAll("_", " ")}
                    />
                    <span>
                      {challan.line_count} {challan.line_count === 1 ? "line" : "lines"}
                    </span>
                    <span>{formatDateTime(challan.created_at)}</span>
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
