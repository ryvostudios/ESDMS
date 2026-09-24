export function formatEnumLabel(value) {
  if (!value) return "";
  if (value === "CEO") return "CEO";
  if (value === "ADMIN") return "Site Administrator";
  // Display name only: the stable role code stays GATE_GUARD everywhere.
  if (value === "GATE_GUARD") return "Gate Keeper";
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
