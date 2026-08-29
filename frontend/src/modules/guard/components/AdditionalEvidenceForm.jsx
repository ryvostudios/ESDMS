import { useState } from "react";
import { FormField, Input } from "../../../shared/components/FormField.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { EvidencePhotoInput } from "./EvidencePhotoInput.jsx";
import { addGateEvidence } from "../api.js";
import styles from "./GateActionForm.module.css";

// Inbound evidence for something that was NOT on the approved Gate Pass.
//
// This is the case the gate actually hits: a vehicle comes back carrying
// something nobody listed on the way out. The Guard must be able to record
// it — refusing the photo would mean the only durable record of it is a
// memory. It is filed as independent gate evidence: it never joins the
// approved item list and never reopens approved history, which is why it
// carries a mandatory description of its own.
export function AdditionalEvidenceForm({ gatePassId, onRecorded }) {
  const [photos, setPhotos] = useState([]);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [recorded, setRecorded] = useState(0);

  async function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    const nextErrors = {};
    if (!photos.length) nextErrors.photos = "At least one photo is required.";
    if (!note.trim()) nextErrors.note = "Describe what this evidence shows.";
    setErrors(nextErrors);
    setFormError(null);
    if (Object.keys(nextErrors).length) return;

    setSubmitting(true);
    try {
      await addGateEvidence(gatePassId, { kind: "INBOUND_ADDITIONAL", note: note.trim(), photos });
      setRecorded((count) => count + photos.length);
      setPhotos([]);
      setNote("");
      onRecorded?.();
    } catch (error) {
      setFormError(error.message || "Unable to record this evidence. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit} noValidate>
      <h2 className={styles.title}>Additional inbound evidence</h2>
      <p>
        Use this for anything arriving at the gate that is not on the approved Gate Pass. It is recorded as gate
        evidence only — the approved item list is never changed.
      </p>

      {formError && <p className={styles.formError}>{formError}</p>}
      {recorded > 0 && <p role="status">{recorded} additional photo(s) recorded.</p>}

      <FormField label="What does this show?" htmlFor="additional-note" required error={errors.note}>
        <Input
          id="additional-note"
          value={note}
          maxLength={300}
          onChange={(event) => setNote(event.target.value)}
          error={errors.note}
          disabled={submitting}
        />
      </FormField>

      <FormField label="Photos" required error={errors.photos}>
        <EvidencePhotoInput
          inputId="additional-evidence-photo"
          value={photos}
          onChange={(files, error) => {
            setPhotos(files);
            setErrors((prev) => ({ ...prev, photos: error || undefined }));
          }}
          disabled={submitting}
        />
      </FormField>

      <Button type="submit" className={styles.submit} loading={submitting}>
        Record additional evidence
      </Button>
    </form>
  );
}
