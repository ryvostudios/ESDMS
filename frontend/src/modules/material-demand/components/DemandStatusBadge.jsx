import { StatusBadge } from "../../../shared/components/StatusBadge.jsx";
import { formatEnumLabel } from "../../../shared/utilities/format.js";
import { STATUS_TONE } from "../constants.js";

export function DemandStatusBadge({ status }) {
  return <StatusBadge tone={STATUS_TONE[status] || "neutral"} label={formatEnumLabel(status)} />;
}
