import { use$ } from "applesauce-react/hooks";
import { concordState$, dismissConcordDiagnostics, retryConcordCleanup } from "../services/concord";

/** Background failures are retained by the service, including before UI mount. */
export function ConcordDiagnostics() {
  const state = use$(concordState$);
  if (!state || (!state.diagnostics.length && !state.cleanup.length)) return null;
  return <div role="alert" className="fixed top-3 right-3 z-50 max-w-sm alert alert-warning">
    <div>
      <p className="font-semibold">Community activity needs attention</p>
      {[...state.diagnostics, ...state.cleanup].map((item, index) => <p key={index} className="text-xs break-words">
        {item.stage}: {item.error instanceof Error ? item.error.message : String(item.error)}
      </p>)}
      {!!state.cleanup.length && <div className="mt-2">
        <p className="text-xs">Local data could not be deleted. Affected storage stays closed until cleanup succeeds. Retrying does not resend community activity.</p>
        <button className="btn btn-warning btn-xs mt-1" disabled={state.retryingCleanup} onClick={() => void retryConcordCleanup()}>
          {state.retryingCleanup ? "Retrying local cleanup…" : "Retry local cleanup"}
        </button>
        {state.cleanupError !== undefined && <p className="text-xs break-words">
          Cleanup retry failed: {state.cleanupError}
        </p>}
      </div>}
    </div>
    <button className="btn btn-ghost btn-xs" disabled={state.retryingCleanup} onClick={dismissConcordDiagnostics}>Dismiss</button>
  </div>;
}
