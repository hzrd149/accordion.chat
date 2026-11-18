import { use$ } from "applesauce-react/hooks";
import type { ReactNode } from "react";
import { debounceTime } from "rxjs";
import { concordState$, retryConcord, syncCommunityKeys } from "../services/concord";
import { ConcordDiagnostics } from "./ConcordDiagnostics";

/** Presentation only: the service owns clients even while this UI is unmounted. */
export function ConcordBoundary({ children }: { children: ReactNode }) {
  const state = use$(concordState$);
  if (!state) return null;
  return <>
    {state.error && (
      <div role="alert" className="alert alert-error fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-lg">
        <span>Could not start your communities: {state.error}</span>
        <button className="btn btn-sm" disabled={state.status === "starting"} onClick={retryConcord}>Retry</button>
      </div>
    )}
    {state.client && <>
      <CommunityKeySync key={state.accountId} />
      <ConcordDiagnostics />
      {children}
    </>}
  </>;
}

function CommunityKeySync() {
  const state = use$(concordState$);
  const client = state?.client;
  const dirty = use$(() => client?.communityListDirty$.pipe(debounceTime(1500)), [client]);
  if (!dirty || !state) return null;
  return (
    <div role="status" className="alert alert-warning fixed bottom-4 right-4 z-50 max-w-sm">
      <div>
        <p>Community keys have changes waiting to sync to your other devices.</p>
        {state.syncError && <p className="text-error">{state.syncError}</p>}
      </div>
      <button className="btn btn-sm" disabled={state.syncing} onClick={() => void syncCommunityKeys()}>
        {state.syncing ? "Syncing…" : "Retry"}
      </button>
    </div>
  );
}
