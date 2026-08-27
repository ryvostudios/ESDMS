// Turns a fetched Blob into a browser download. Every new Procurement/
// Receiving document and export goes through here rather than repeating the
// object-URL dance at each call site — and, importantly, the object URL is
// always revoked, including when the click handler throws.
//
// The filename comes from the SERVER's Content-Disposition wherever possible;
// the fallback is only used when the browser did not expose that header. The
// backend already sanitizes it (document-number.js#documentFilename).
export async function downloadBlob(blob, fallbackName) {
  const url = URL.createObjectURL(blob);

  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = fallbackName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
