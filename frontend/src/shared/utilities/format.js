// Acronyms stay upper-case when an enum is humanised ("HR", not "Hr";
// "Ready For IPO", not "Ready For Ipo").
const ACRONYMS = new Set(["HR", "IPO", "CEO", "CFO", "CTO", "DC", "HSE", "WTG", "UOM"]);

export function formatEnumLabel(value) {
  if (!value) return "";
  if (value === "CEO") return "CEO";
  if (value === "ADMIN") return "Site Administrator";
  // Display name only: the stable role code stays GATE_GUARD everywhere.
  if (value === "GATE_GUARD") return "Gate Keeper";
  return value
    .toLowerCase()
    .split("_")
    .map((word) => (ACRONYMS.has(word.toUpperCase()) ? word.toUpperCase() : word[0].toUpperCase() + word.slice(1)))
    .join(" ");
}
