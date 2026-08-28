import { useNavigate } from "react-router-dom";
import { PageHeader } from "../../shared/components/PageHeader.jsx";
import { Button } from "../../shared/components/Button.jsx";
import { EmptyState } from "../../shared/components/StatePanel.jsx";

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div>
      <PageHeader title="Page not found" description="This address doesn't match anything in ESDMS." />
      <EmptyState
        title="Page not found"
        message="The link may be out of date, or the address may have been typed incorrectly."
        action={<Button onClick={() => navigate("/", { replace: true })}>Go to Dashboard</Button>}
      />
    </div>
  );
}
