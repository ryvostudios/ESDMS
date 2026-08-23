// OWASP CSV/Formula Injection mitigation: a cell value that is a string
// and starts with a character a spreadsheet application would interpret as
// the start of a formula (=, +, -, @, tab, carriage return) is prefixed
// with a single quote, forcing it to render as literal text. Applied to
// every user-supplied string written into any generated workbook — see
// docs/DECISIONS.md and reports.service.js.
const DANGEROUS_LEADING_CHARS = ["=", "+", "-", "@", "\t", "\r"];

export function sanitizeCell(value) {
  if (typeof value !== "string") return value;
  if (DANGEROUS_LEADING_CHARS.some((char) => value.startsWith(char))) {
    return `'${value}`;
  }
  return value;
}

export function safeExportFilename(prefix, extension) {
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date()); // YYYY-MM-DD
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "");
  return `${safePrefix}_${date}.${extension}`;
}
