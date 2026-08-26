import { useState } from "react";
import { Link } from "react-router-dom";
import { useDebouncedValue } from "../../../shared/hooks/useDebouncedValue.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { SearchField } from "../../../shared/components/SearchField.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { usePricingQueue } from "../hooks/usePricingQueue.js";
import styles from "./PricingQueuePage.module.css";

const PAGE_SIZE = 20;

export function PricingQueuePage() {
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const debouncedSearch = useDebouncedValue(search, 300);
  const { rows, total, status, error, reload } = usePricingQueue({
    search: debouncedSearch,
    page,
    pageSize: PAGE_SIZE,
  });

  return (
    <div>
      <PageHeader title="Procurement — Pricing Work" description="Approved Demands awaiting initial pricing or controlled repricing." />
      <div className={styles.search}>
        <SearchField
          value={search}
          onChange={(value) => {
            setSearch(value);
            setPage(1);
          }}
          placeholder="Search by Demand number"
          ariaLabel="Search Procurement queue"
        />
      </div>

      {status === "loading" && <LoadingState message="Loading Procurement queue…" />}
      {status === "error" && <ErrorState message={error} onRetry={reload} />}
      {status === "ready" && rows.length === 0 && (
        <EmptyState title="No Demands ready for pricing" message="Newly approved Demands will appear here." />
      )}
      {status === "ready" && rows.length > 0 && (
        <>
          <div className={styles.list}>
            {rows.map((demand) => (
              <Link key={demand.id} to={`/procurement/pricing/${demand.id}`} className={styles.row}>
                <div>
                  <strong>{demand.demand_number}</strong>
                  <span>{demand.department_name}</span>
                </div>
                <div className={styles.meta}>
                  <span>{demand.line_count} {demand.line_count === 1 ? "item" : "items"}</span>
                  <span>
                    {demand.status === "PRICING_REVISION_REQUIRED"
                      ? "Repricing Required"
                      : demand.pricing_status === "DRAFT"
                        ? `Pricing Version ${demand.pricing_version} draft saved`
                        : "Ready for Pricing"}
                  </span>
                </div>
              </Link>
            ))}
          </div>
          <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
        </>
      )}
    </div>
  );
}
