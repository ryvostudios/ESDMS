import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../shared/components/PageHeader.jsx";
import { Button } from "../../shared/components/Button.jsx";
import { EmptyState } from "../../shared/components/StatePanel.jsx";

export function AccessDeniedPage() {
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title="Access denied" description="This area isn't part of your role." />
      <EmptyState
        title="You don't have permission to access this page"
        message="If you think you should have access, ask your administrator to review your permissions."
        action={<Button onClick={() => navigate("/", { replace: true })}>Go to Dashboard</Button>}
      />
    </div>
  );
}
