import { useState } from "react";
import { useParams } from "react-router-dom";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { Input, Textarea } from "../../../shared/components/FormField.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";
import { getPricing, savePricing, startRepricing, submitPricing } from "../api.js";
import { usePricing } from "../hooks/usePricing.js";
import { formatPkr } from "../utilities/money.js";
import { ApprovalPanel } from "../../material-demand/components/ApprovalPanel.jsx";
import styles from "./PricingPage.module.css";

const PRICE_PATTERN = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;

function isValidPrice(value) {
  return PRICE_PATTERN.test(value) && Number(value) > 0;
}

function PricingEditor({ initialDetail, onReload, onSelectVersion }) {
  const [detail, setDetail] = useState(initialDetail);
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      initialDetail.lines.map((line) => [
        line.demand_line_id,
        { price: line.estimated_unit_price || "", note: line.procurement_note || "" },
      ]),
    ),
  );
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const submitted = detail.pricing?.status === "SUBMITTED";
  const pricingVersion = detail.pricing?.version || 1;
  const latestVersion = detail.versions?.[0]?.version || pricingVersion;
  const historical = Boolean(detail.pricing) && pricingVersion !== latestVersion;
  const complete = detail.lines.every((line) => isValidPrice(values[line.demand_line_id]?.price || ""));

  function lineTotal(line) {
    const price = values[line.demand_line_id]?.price;
    return isValidPrice(price) ? Number(line.requested_quantity) * Number(price) : 0;
  }

  const displayedTotal = detail.lines.reduce((total, line) => total + lineTotal(line), 0);

  function body() {
    return {
      revision: detail.demand.revision,
      pricingVersion,
      currency: "PKR",
      lines: detail.lines
        .filter((line) => (values[line.demand_line_id]?.price || "").trim() !== "")
        .map((line) => ({
          demandLineId: line.demand_line_id,
          estimatedUnitPrice: values[line.demand_line_id].price,
          procurementNote: values[line.demand_line_id].note || null,
        })),
    };
  }

  async function save() {
    setBusy("save");
    setActionError(null);
    try {
      const response = await savePricing(detail.demand.id, body());
      setDetail(response.data);
      await onReload();
    } catch (error) {
      setActionError(error.message || "Unable to save pricing.");
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!complete) return;
    setBusy("submit");
    setActionError(null);
    try {
      await savePricing(detail.demand.id, body());
      await submitPricing(detail.demand.id, { revision: detail.demand.revision, pricingVersion });
      const response = await getPricing(detail.demand.id);
      setDetail(response.data);
      await onReload();
    } catch (error) {
      setActionError(error.message || "Unable to submit pricing.");
    } finally {
      setBusy(null);
    }
  }

  async function beginRepricing() {
    setBusy("repricing");
    setActionError(null);
    try {
      const response = await startRepricing(detail.demand.id, { revision: detail.demand.revision });
      setDetail(response.data);
      await onReload();
    } catch (error) {
      setActionError(error.message || "Unable to start repricing.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader
        title={`${detail.demand.department_name} — ${detail.demand.demand_number}`}
        description={
          historical
            ? `Historical Pricing Version ${pricingVersion} — read only`
            : submitted
              ? `Submitted estimated market pricing · Demand revision ${detail.demand.revision} · Version ${pricingVersion}`
              : `Enter estimated market pricing · Demand revision ${detail.demand.revision} · Version ${pricingVersion}`
        }
      />

      {detail.versions?.length > 1 && (
        <div className={styles.actions} aria-label="Pricing version history">
          {detail.versions.map((version) => (
            <Button
              key={version.id}
              variant={version.version === pricingVersion ? "primary" : "secondary"}
              onClick={() => onSelectVersion(version.version === latestVersion ? null : version.version)}
            >
              Version {version.version}
            </Button>
          ))}
        </div>
      )}

      <p className={styles.historyNote}>Previous Purchase Price is unavailable until actual purchasing history exists.</p>
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}

      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Item</th>
              <th>Approved Qty</th>
              <th>Unit</th>
              <th>Estimated Unit Price (PKR)</th>
              <th>Line Total</th>
            </tr>
          </thead>
          <tbody>
            {detail.lines.map((line) => {
              const value = values[line.demand_line_id] || { price: "", note: "" };
              return (
                <tr key={line.demand_line_id}>
                  <td>
                    <strong>{line.item_name_snapshot}</strong>
                    <Textarea
                      aria-label={`Procurement note for ${line.item_name_snapshot}`}
                      placeholder="Optional Procurement note"
                      value={value.note}
                      readOnly={submitted}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [line.demand_line_id]: { ...value, note: event.target.value },
                      }))}
                    />
                  </td>
                  <td>{line.requested_quantity}</td>
                  <td>{line.uom_name_snapshot}</td>
                  <td>
                    <Input
                      aria-label={`Estimated unit price for ${line.item_name_snapshot}`}
                      inputMode="decimal"
                      value={value.price}
                      readOnly={submitted}
                      onChange={(event) => setValues((current) => ({
                        ...current,
                        [line.demand_line_id]: { ...value, price: event.target.value },
                      }))}
                    />
                  </td>
                  <td>{value.price ? (isValidPrice(value.price) ? formatPkr(lineTotal(line)) : "Invalid price") : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className={styles.footer}>
        <div>
          <span>Estimated Total</span>
          <strong>{formatPkr(submitted ? detail.estimatedTotal : displayedTotal)}</strong>
        </div>
        {!submitted && (
          <div className={styles.actions}>
            <Button variant="secondary" loading={busy === "save"} disabled={Boolean(busy)} onClick={save}>
              Save Draft
            </Button>
            <Button loading={busy === "submit"} disabled={Boolean(busy) || !complete} onClick={submit}>
              Submit Pricing
            </Button>
          </div>
        )}
      </div>
      {!complete && !submitted && <p className={styles.hint}>Enter a valid price greater than zero for every line before submitting.</p>}
      {historical && <p className={styles.submitted}>Historical submitted Pricing Version {pricingVersion} · Read only</p>}
      {!historical && detail.demand.status === "PENDING_FINAL_APPROVAL" && (
        <p className={styles.submitted}>Pending Final Management Review / Formal Approval</p>
      )}
      {!historical && detail.demand.status === "PRICING_REVISION_REQUIRED" && (
        <div className={styles.actions}>
          <p className={styles.submitted}>Pricing Version {pricingVersion} was rejected and remains read only.</p>
          {detail.canStartRevision && (
            <Button loading={busy === "repricing"} disabled={Boolean(busy)} onClick={beginRepricing}>
              Start Pricing Version {pricingVersion + 1}
            </Button>
          )}
        </div>
      )}
      {!historical && detail.demand.status === "READY_FOR_IPO" && (
        <p className={styles.submitted}>Ready for IPO</p>
      )}
    </div>
  );
}

export function PricingPage() {
  const { demandId } = useParams();
  const [selectedVersion, setSelectedVersion] = useState(null);
  const { result, status, error, reload } = usePricing(demandId, selectedVersion);

  if (status === "loading") return <LoadingState message="Loading Procurement pricing…" />;
  if (status === "error") return <ErrorState message={error} onRetry={() => reload().catch(() => {})} />;

  return (
    <>
      <PricingEditor
        key={`${result.pricing?.id || "new"}:${result.pricing?.updated_at || ""}`}
        initialDetail={result}
        onReload={reload}
        onSelectVersion={setSelectedVersion}
      />
      {result.finalApprovals?.length > 0 && (
        <ApprovalPanel
          approvals={result.finalApprovals}
          stage="FINAL"
          title={`Final Decision History · Pricing Version ${result.pricing.version}`}
          canReview={false}
          canApprove={false}
        />
      )}
    </>
  );
}
