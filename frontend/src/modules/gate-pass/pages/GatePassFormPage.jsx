import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { getGatePass, createGatePass, updateGatePassDraft } from "../api.js";
import { GatePassForm } from "../components/GatePassForm.jsx";
import { PageHeader } from "../../../shared/components/PageHeader.jsx";
import { LoadingState, ErrorState } from "../../../shared/components/StatePanel.jsx";

function toFormValues(gatePass) {
  return {
    issuingDepartmentId: gatePass.issuingDepartmentId,
    requestedBy: gatePass.requestedBy,
    destination: gatePass.destination,
    driverName: gatePass.driverName,
    driverPhone: gatePass.driverPhone,
    vehicleRegistration: gatePass.vehicleRegistration,
    jobOrderId: gatePass.jobOrderId || "",
    purpose: gatePass.purpose,
    expectedReturnDate: gatePass.expectedReturnDate ? gatePass.expectedReturnDate.slice(0, 10) : "",
    remarks: gatePass.remarks || "",
  };
}

function toFormItems(items) {
  return items.map((item) => ({
    description: item.description,
    partNumber: item.partNumber || "",
    quantity: String(item.quantity),
    unit: item.unit || "",
  }));
}

export function GatePassFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isEdit = Boolean(id);

  const [loadStatus, setLoadStatus] = useState(isEdit ? "loading" : "ready");
  const [loadError, setLoadError] = useState(null);
  const [gatePass, setGatePass] = useState(null);

  useEffect(() => {
    if (!isEdit) return;

    let cancelled = false;

    getGatePass(id)
      .then((response) => {
        if (cancelled) return;

        if (response.data.status !== "DRAFT") {
          navigate(`/gate-passes/${id}`, { replace: true });
          return;
        }

        setGatePass(response.data);
        setLoadStatus("ready");
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadError(error.message || "Unable to load this Gate Pass.");
        setLoadStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [id, isEdit, navigate]);

  // The saved Gate Pass opens at its top, not at the long form's scroll
  // offset (the window keeps it across in-app navigation).
  async function handleSubmit(values) {
    if (isEdit) {
      await updateGatePassDraft(id, values);
      navigate(`/gate-passes/${id}`);
    } else {
      const response = await createGatePass(values);
      navigate(`/gate-passes/${response.data.id}`);
    }
    window.scrollTo(0, 0);
  }

  if (loadStatus === "loading") {
    return <LoadingState message="Loading Gate Pass…" />;
  }

  if (loadStatus === "error") {
    return <ErrorState message={loadError} />;
  }

  return (
    <div>
      <PageHeader
        title={isEdit ? "Edit Gate Pass" : "New Gate Pass"}
        description={isEdit ? "Update this draft before submitting for approval." : "Create a new Gate Pass draft."}
      />
      <GatePassForm
        initialValues={gatePass ? toFormValues(gatePass) : undefined}
        initialItems={gatePass ? toFormItems(gatePass.items) : undefined}
        submitLabel={isEdit ? "Save changes" : "Save draft"}
        onSubmit={handleSubmit}
      />
    </div>
  );
}
