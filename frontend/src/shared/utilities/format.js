export function formatEnumLabel(value) {
  if (!value) return "";
  if (value === "CEO") return "CEO";
  if (value === "ADMIN") return "Site Administrator";
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}
