import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { apiClient } from "../../../core/api/client.js";
import { useAuth } from "../../../core/auth/AuthContext.jsx";
import { buildQuery } from "../../../core/api/query.js";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { FormField, Input, Select } from "../../../shared/components/FormField.jsx";
import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { Pagination } from "../../../shared/components/Pagination.jsx";
import { LoadingState, ErrorState, EmptyState } from "../../../shared/components/StatePanel.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import { downloadBlob } from "../../../shared/utilities/download.js";
import { useIpoList } from "../../ipo/hooks/useIpoList.js";
import { IPO_STATUSES, IPO_STATUS_TONE } from "../../ipo/constants.js";
import styles from "./ProcurementHistoryPage.module.css";

const PAGE_SIZE = 20;

export function ProcurementHistoryPage() {
  const { hasPermission } = useAuth();
  const [filters, setFilters] = useState({ status: "", from: "", to: "", reference: "" });
  const [page, setPage] = useState(1);
  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState(null);
  const [exportError, setExportError] = useState(null);
  const [exporting, setExporting] = useState(null);

  const { rows, total, status, error, reload } = useIpoList({
    search: filters.reference,
    status: filters.status,
    page,
    pageSize: PAGE_SIZE,
  });

  // The history trace itself only needs IPO visibility, which is why this page
  // is offered to Procurement Staff and department leads alike. The EXPORT
  // catalog is separately gated on procurement.export, so asking for it
  // without that capability produced a guaranteed 403 on every mount —
  // swallowed silently, leaving the page quietly promising an export section
  // it would never render. Ask only when the answer can be yes.
  const canExport = hasPermission("procurement.export");

  const loadCatalog = useCallback(
    () =>
      apiClient
        .get("/reports/procurement/catalog")
        .then((response) => {
          setCatalog(response.data);
          setCatalogError(null);
        })
        // A genuine failure is now visible rather than indistinguishable from
        // "you may not export".
        .catch((error) => setCatalogError(error.message || "Unable to load the export catalog.")),
    [],
  );

  useEffect(() => {
    // `catalog` already starts empty, so an unauthorized user needs no state
    // change at all — just no request.
    if (!canExport) return;
    loadCatalog();
  }, [canExport, loadCatalog]);

  function update(field, value) {
    setFilters((current) => ({ ...current, [field]: value }));
    setPage(1);
  }

  async function handleExport(datasetKey) {
    setExporting(datasetKey);
    setExportError(null);
    try {
      // Filters are sent to the server, which applies them in SQL — the
      // browser never downloads an unfiltered dataset to narrow itself.
      const blob = await apiClient.getBlob(`/reports/procurement/${datasetKey}.xlsx${buildQuery(filters)}`);
      await downloadBlob(blob, `${datasetKey}.xlsx`);
    } catch (downloadError) {
      setExportError(downloadError.message || "Unable to generate the export.");
    } finally {
      setExporting(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Procurement History"
        description="Trace any Demand through pricing, approval, IPO, purchasing, delivery and receiving — and export what you are authorized to see."
      />

      <section className={styles.filters} aria-label="Filters">
        <FormField label="Reference" htmlFor="filter-reference">
          <Input
            id="filter-reference"
            value={filters.reference}
            placeholder="IPO or Demand number"
            onChange={(event) => update("reference", event.target.value)}
          />
        </FormField>
        <FormField label="Status" htmlFor="filter-status">
          <Select id="filter-status" value={filters.status} onChange={(event) => update("status", event.target.value)}>
            <option value="">All statuses</option>
            {IPO_STATUSES.map((value) => (
              <option key={value} value={value}>
                {value.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="From" htmlFor="filter-from">
          <Input id="filter-from" type="date" value={filters.from} onChange={(event) => update("from", event.target.value)} />
        </FormField>
        <FormField label="To" htmlFor="filter-to">
          <Input id="filter-to" type="date" value={filters.to} onChange={(event) => update("to", event.target.value)} />
        </FormField>
      </section>

      <section className={styles.exports} aria-labelledby="exports-title">
        <h2 id="exports-title" className={styles.sectionTitle}>
          Excel exports
        </h2>
        {!canExport ? (
          <p className={styles.hint}>
            Exporting this history needs the procurement.export capability, which your role does not currently
            include. The history above is unaffected.
          </p>
        ) : (
          <>
          <p className={styles.hint}>
            Exports apply the filters above and contain only the data you are authorized to see — a user without
            price permission never receives pricing columns.
          </p>
          <div className={styles.exportButtons}>
            {catalog.map((dataset) => (
              <Button
                key={dataset.key}
                variant="secondary"
                loading={exporting === dataset.key}
                onClick={() => handleExport(dataset.key)}
              >
                {dataset.name}
              </Button>
            ))}
          </div>
          {exportError && (
            <p className={styles.error} role="alert">
              {exportError}
            </p>
          )}
          </>
        )}
        {catalogError && (
          <p className={styles.error} role="alert">
            {catalogError}
          </p>
        )}
      </section>

      {status === "loading" && <LoadingState message="Loading history…" />}
      {status === "error" && <ErrorState message={error} onRetry={reload} />}
      {status === "ready" && rows.length === 0 && (
        <EmptyState title="No matching records" message="Adjust the filters to widen the search." />
      )}
      {status === "ready" && rows.length > 0 && (
        <>
          <ul className={styles.list}>
            {rows.map((ipo) => (
              <li key={ipo.id}>
                <Link to={`/ipos/${ipo.id}`} className={styles.row}>
                  <div className={styles.identity}>
                    <strong>{ipo.ipo_number}</strong>
                    <span>
                      {ipo.department_name} · Demand {ipo.demand_number} · generated{" "}
                      {formatDateTime(ipo.generated_at)}
                    </span>
                    {ipo.completed_at && <span>Completed {formatDateTime(ipo.completed_at)}</span>}
                  </div>
                  <StatusBadge tone={IPO_STATUS_TONE[ipo.status]} label={ipo.status.replaceAll("_", " ")} />
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
