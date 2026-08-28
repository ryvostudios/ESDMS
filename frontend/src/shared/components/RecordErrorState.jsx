import { ErrorState } from "./StatePanel.jsx";
import { describeApiError } from "../utilities/error-presentation.js";

export function RecordErrorState({ error, onRetry, fallback }) {
  const presentation = describeApiError(error, fallback);
  return <ErrorState title={presentation.title} message={presentation.message} onRetry={presentation.retryable ? onRetry : undefined} />;
}
