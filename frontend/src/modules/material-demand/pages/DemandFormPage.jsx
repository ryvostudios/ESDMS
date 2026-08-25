import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getDemand, createDemand, updateDemandDraft } from "../api.js";
import { DemandForm } from "../components/DemandForm.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";

export function DemandFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [loadStatus, setLoadStatus] = useState(isEdit ? "loading" : "ready");
  const [loadError, setLoadError] = useState(null);
  const [demand, setDemand] = useState(null);
  const [lines, setLines] = useState([]);

  useEffect(() => {
    if (!isEdit) return;

    let cancelled = false;

    getDemand(id)
      .then((response) => {
        if (cancelled) return;

        if (response.data.demand.status !== "DRAFT") {
          navigate(`/demands/${id}`, { replace: true });
          return;
        }

        setDemand(response.data.demand);
        setLines(response.data.lines);
        setLoadStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error.message || "Unable to load this Demand.");
        setLoadStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [id, isEdit, navigate]);

  async function handleSubmit(values) {
    if (isEdit) {
      await updateDemandDraft(id, values);
      navigate(`/demands/${id}`);
    } else {
      const response = await createDemand(values);
      navigate(`/demands/${response.data.demand.id}`);
    }
  }

  if (loadStatus === "loading") {
    return <LoadingState message="Loading Demand…" />;
  }

  if (loadStatus === "error") {
    return <ErrorState message={loadError} />;
  }

  return (
    <div>
      <PageHeader
        title={isEdit ? `Edit ${demand.demand_number}` : "New Demand"}
        description={isEdit ? "Update this draft before submitting for review." : "Create a new department material Demand."}
      />
      <DemandForm
        initialDemand={demand || undefined}
        initialLines={lines}
        submitLabel={isEdit ? "Save changes" : "Save draft"}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
