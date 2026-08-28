import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { API_BASE_URL, BUILD_REVISION } from "../../core/config/env.js";
import { ErrorState, LoadingState } from "../../shared/components/StatePanel.jsx";

export function DiagnosticsPage() {
  const [state, setState] = useState({ loading: true, data: null, error: null });

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/health/ready`, { signal: controller.signal })
      .then(async (response) => ({ response, body: await response.json() }))
      .then(({ response, body }) => setState({ loading: false, data: body.data, error: response.ok ? null : "Backend is not ready." }))
      .catch((error) => {
        if (error.name !== "AbortError") setState({ loading: false, data: null, error: "Backend diagnostics are unavailable." });
      });
    return () => controller.abort();
  }, []);

  if (state.loading) return <LoadingState message="Checking deployment compatibility…" />;
  if (!state.data) return <ErrorState title="Diagnostics unavailable" message={state.error} />;

  const revisionsMatch = BUILD_REVISION === state.data.backendRevision;
  return (
    <main style={{ maxWidth: 720, margin: "3rem auto", padding: "1.5rem" }}>
      <h1>Deployment diagnostics</h1>
      <dl>
        <dt>Frontend revision</dt><dd>{BUILD_REVISION}</dd>
        <dt>Backend revision</dt><dd>{state.data.backendRevision}</dd>
        <dt>Frontend/backend match</dt><dd>{revisionsMatch ? "Yes" : "No"}</dd>
        <dt>Expected database compatibility</dt><dd>{state.data.expectedMigration}</dd>
        <dt>Latest applied migration</dt><dd>{state.data.latestAppliedMigration || "Unavailable"}</dd>
        <dt>Schema compatible</dt><dd>{state.data.schemaCompatible ? "Yes" : "No"}</dd>
      </dl>
      {state.error && <p role="alert">{state.error}</p>}
      <Link to="/">Return to application</Link>
    </main>
  );
}
