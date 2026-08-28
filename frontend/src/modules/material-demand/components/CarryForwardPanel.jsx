import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../shared/components/Button.jsx";
import { formatDateTime } from "../../../shared/utilities/datetime.js";
import * as catalogApi from "../../material-catalog/api.js";
import { listOutstandingForCatalogEntries } from "../api.js";
import styles from "./CarryForwardPanel.module.css";

const SOURCE_LABEL = {
  UNPURCHASED_IPO_QUANTITY: "Approved but not fully purchased",
  OUT_OF_BUDGET: "Excluded by management",
  RECEIVING_SHORTAGE: "Delivered short",
};

// Unresolved requirements from this department's earlier procurement, shown
// while a new Demand is being built.
//
// Nothing is added automatically and nothing is submitted on the user's
// behalf: a carried-forward quantity is a SUGGESTION the creator explicitly
// accepts, and remains editable afterwards like any other line. The original
// IPO and the original exclusion decision are never modified by anything here.
export function CarryForwardPanel({ departmentId, selections, onAdd }) {
  const [candidates, setCandidates] = useState([]);
  const [loaded, setLoaded] = useState(false);

  // Asks about the department's whole catalogue, not only what is already
  // selected — the point is to surface what the creator has NOT yet thought
  // to add. Scope is still enforced server-side against the actor.
  const load = useCallback(() => {
    if (!departmentId) {
      setCandidates([]);
      setLoaded(true);
      return Promise.resolve();
    }

    return catalogApi
      .listAllCatalog({ departmentId })
      .then((response) => {
        const catalogEntryIds = response.data.map((entry) => entry.id);
        if (catalogEntryIds.length === 0) return { data: [] };
        return listOutstandingForCatalogEntries(catalogEntryIds, departmentId);
      })
      .then((response) => setCandidates(response.data))
      // Carry-forward is an assist, never a blocker: a department user
      // without visibility into prior IPOs simply sees no suggestions.
      .catch(() => setCandidates([]))
      .finally(() => setLoaded(true));
  }, [departmentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  if (!loaded || candidates.length === 0) return null;

  return (
    <section className={styles.panel} aria-labelledby="carry-forward-title">
      <h3 id="carry-forward-title" className={styles.title}>
        Outstanding from previous procurement
      </h3>
      <p className={styles.hint}>
        These quantities were requested before but never delivered. Carrying one forward claims it against its
        source, so it cannot also be carried into another Demand — the claim is made when you submit, and the
        amount stays editable until then. Skipping one changes nothing.
      </p>
      <ul className={styles.list}>
        {candidates.map((candidate) => {
          const alreadySelected = Boolean(selections[candidate.catalog_entry_id]);
          return (
            <li key={`${candidate.source_type}-${candidate.source_id}`}>
              <div className={styles.candidate}>
                <strong>{candidate.item_name_snapshot}</strong>
                <span>
                  Outstanding available: {candidate.available_quantity} {candidate.uom_code_snapshot}
                  {Number(candidate.allocated_quantity) > 0
                    ? ` (of ${candidate.source_quantity} — ${candidate.allocated_quantity} already carried into later Demands)`
                    : ""}
                </span>
                <span>
                  {SOURCE_LABEL[candidate.source_type]}
                  {candidate.exclusion_category
                    ? ` — ${candidate.exclusion_category.replaceAll("_", " ").toLowerCase()}`
                    : ""}
                  {candidate.discrepancy_type
                    ? ` — ${candidate.discrepancy_type.replaceAll("_", " ").toLowerCase()}`
                    : ""}
                </span>
                <span>
                  Source: {candidate.ipo_number || candidate.demand_number}
                  {candidate.resolved_at ? ` · ${formatDateTime(candidate.resolved_at)}` : ""}
                </span>
              </div>
              <Button
                variant="secondary"
                disabled={alreadySelected}
                onClick={() =>
                  onAdd(candidate.catalog_entry_id, candidate.available_quantity, {
                    sourceType: candidate.source_type,
                    sourceId: candidate.source_id,
                    quantity: Number(candidate.available_quantity),
                  })
                }
              >
                {alreadySelected ? "Already in this Demand" : "Carry forward"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
