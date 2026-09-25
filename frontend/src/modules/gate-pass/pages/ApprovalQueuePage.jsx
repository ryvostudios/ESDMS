import { GatePassListView } from "../components/GatePassListView.jsx";

export function ApprovalQueuePage() {
  return (
    <GatePassListView
      title="Gate Pass Approvals"
      description="Gate Passes awaiting your decision."
      fixedStatus="PENDING_APPROVAL"
      showStatusFilter={false}
      showCreateAction={false}
    />
  );
}
