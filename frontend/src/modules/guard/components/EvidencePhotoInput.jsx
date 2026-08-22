import { useEffect, useRef, useState } from "react";
import { CameraIcon, CloseIcon } from "../../../shared/icons.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { ALLOWED_PHOTO_MIME_TYPES, MAX_EVIDENCE_PHOTO_BYTES } from "../constants.js";
import styles from "./EvidencePhotoInput.module.css";

export function EvidencePhotoInput({ value, onChange, disabled }) {
  const inputRef = useRef(null);
  const [previewUrl, setPreviewUrl] = useState(null);

  // Single place that owns previewUrl's lifetime: this runs its cleanup
  // (revoking the *previous* URL) both when previewUrl changes to a new
  // one — replacing a photo without explicitly removing it first — and on
  // unmount, so a blob URL never outlives what it's a preview for.
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFileSelect(event) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_PHOTO_MIME_TYPES.includes(file.type)) {
      onChange(null, "Photo must be JPEG, PNG, or WebP.");
      return;
    }

    if (file.size > MAX_EVIDENCE_PHOTO_BYTES) {
      onChange(null, "Photo must be under 5 MB.");
      return;
    }

    setPreviewUrl(URL.createObjectURL(file));
    onChange(file, null);
  }

  function handleRemove() {
    setPreviewUrl(null);
    onChange(null, null);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <div className={styles.wrapper}>
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        onChange={handleFileSelect}
        disabled={disabled}
        id="evidence-photo"
      />

      {value && previewUrl ? (
        <div className={styles.previewWrapper}>
          <img src={previewUrl} alt="Evidence preview" className={styles.preview} />
          <Button
            type="button"
            variant="secondary"
            className={styles.removeButton}
            onClick={handleRemove}
            disabled={disabled}
            aria-label="Remove photo"
          >
            <CloseIcon width={16} height={16} />
          </Button>
        </div>
      ) : (
        <label htmlFor="evidence-photo" className={styles.dropzone}>
          <CameraIcon width={28} height={28} />
          Tap to take or choose a photo
        </label>
      )}
    </div>
  );
}
