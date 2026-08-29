import { useEffect, useMemo, useRef } from "react";
import { CameraIcon, CloseIcon } from "../../../shared/icons.jsx";
import { Button } from "../../../shared/components/Button.jsx";
import { ALLOWED_PHOTO_MIME_TYPES, MAX_EVIDENCE_PHOTO_BYTES, MAX_EVIDENCE_PHOTOS } from "../constants.js";
import styles from "./EvidencePhotoInput.module.css";

// Captures a SET of evidence photos. A Guard routinely photographs several
// angles of the same load, and forcing one photo per gate event meant the
// rest simply went unrecorded.
//
// `value` is always an array of File. Object URLs are created once per file
// and revoked when that file leaves the set (or on unmount), so a preview
// URL never outlives the file it previews.
export function EvidencePhotoInput({ value = [], onChange, disabled, inputId = "evidence-photo" }) {
  const inputRef = useRef(null);

  // One preview URL per file in the current set. Derived from `value` rather
  // than mirrored into state, so there is no second copy to fall out of sync
  // when the parent clears the set (as it does after a successful upload).
  const previews = useMemo(
    () => value.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [value],
  );

  // Runs when `previews` is replaced AND on unmount, so a blob URL never
  // outlives the render that created it.
  useEffect(() => {
    return () => {
      for (const entry of previews) URL.revokeObjectURL(entry.url);
    };
  }, [previews]);

  function handleFileSelect(event) {
    const selected = Array.from(event.target.files ?? []);
    if (!selected.length) return;

    if (selected.some((file) => !ALLOWED_PHOTO_MIME_TYPES.includes(file.type))) {
      onChange(value, "Photos must be JPEG, PNG, or WebP.");
      return;
    }

    if (selected.some((file) => file.size > MAX_EVIDENCE_PHOTO_BYTES)) {
      onChange(value, "Each photo must be under 5 MB.");
      return;
    }

    if (value.length + selected.length > MAX_EVIDENCE_PHOTOS) {
      onChange(value, `You can attach at most ${MAX_EVIDENCE_PHOTOS} photos at a time.`);
      return;
    }

    onChange([...value, ...selected], null);
    // Cleared so re-selecting the same file still fires a change event.
    if (inputRef.current) inputRef.current.value = "";
  }

  function handleRemove(file) {
    onChange(value.filter((candidate) => candidate !== file), null);
  }

  return (
    <div className={styles.wrapper}>
      <input
        ref={inputRef}
        className={styles.hiddenInput}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        multiple
        onChange={handleFileSelect}
        disabled={disabled}
        id={inputId}
      />

      {previews.map((entry, index) => (
        <div key={entry.url} className={styles.previewWrapper}>
          <img src={entry.url} alt={`Evidence preview ${index + 1}`} className={styles.preview} />
          <Button
            type="button"
            variant="secondary"
            className={styles.removeButton}
            onClick={() => handleRemove(entry.file)}
            disabled={disabled}
            aria-label={`Remove photo ${index + 1}`}
          >
            <CloseIcon width={16} height={16} />
          </Button>
        </div>
      ))}

      {value.length < MAX_EVIDENCE_PHOTOS && (
        <label htmlFor={inputId} className={styles.dropzone}>
          <CameraIcon width={28} height={28} />
          {value.length ? "Add another photo" : "Tap to take or choose photos"}
        </label>
      )}
    </div>
  );
}
