import { useState } from "react";
import { FormField, Input, Textarea } from "../../../shared/components/FormField.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { EvidencePhotoInput } from "./EvidencePhotoInput.jsx";
import styles from "./GateActionForm.module.css";

export function GateActionForm({ mode, minOdometer, onSubmit }) {
  const isReturn = mode === "RETURN";

  const [odometer, setOdometer] = useState("");
  const [photos, setPhotos] = useState([]);
  const [remarks, setRemarks] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors = {};
    const odometerValue = Number(odometer);

    if (!odometer || Number.isNaN(odometerValue) || odometerValue < 0) {
      nextErrors.odometer = "Enter a valid odometer reading.";
    } else if (isReturn && minOdometer != null && odometerValue < minOdometer) {
      nextErrors.odometer = `Must be at least ${minOdometer} (departure reading).`;
    }

    if (!photos.length) {
      nextErrors.photo = "At least one photo is required.";
    }

    setErrors(nextErrors);
    setFormError(null);

    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    setSubmitting(true);

    try {
      await onSubmit({ odometer: odometerValue, photos, remarks: remarks.trim() || undefined });
    } catch (error) {
      setFormError(error.message || "Unable to complete this action. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h2 className={styles.title}>{isReturn ? "Record Return" : "Record Exit"}</h2>

      {formError && <p className={styles.formError}>{formError}</p>}

      <FormField
        label={isReturn ? "Return Odometer" : "Departure Odometer"}
        htmlFor="odometer"
        required
        error={errors.odometer}
        hint={isReturn && minOdometer != null ? `Departure reading was ${minOdometer}.` : undefined}
      >
        <Input
          id="odometer"
          type="number"
          inputMode="numeric"
          min="0"
          value={odometer}
          onChange={(event) => setOdometer(event.target.value)}
          error={errors.odometer}
          disabled={submitting}
        />
      </FormField>

      <FormField
        label={isReturn ? "Return Photos" : "Departure Photos"}
        required
        error={errors.photo}
        hint="Capture as many angles as you need."
      >
        <EvidencePhotoInput
          value={photos}
          onChange={(files, error) => {
            setPhotos(files);
            setErrors((prev) => ({ ...prev, photo: error || undefined }));
          }}
          disabled={submitting}
        />
      </FormField>

      {isReturn && (
        <FormField label="Remarks" htmlFor="remarks" hint="Optional">
          <Textarea
            id="remarks"
            value={remarks}
            onChange={(event) => setRemarks(event.target.value)}
            disabled={submitting}
          />
        </FormField>
      )}

      <Button type="submit" className={styles.submit} loading={submitting}>
        {isReturn ? "Complete Return" : "Confirm Exit"}
      </Button>
    </form>
  );
}
