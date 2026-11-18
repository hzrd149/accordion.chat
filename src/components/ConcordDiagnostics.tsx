import type { ConcordClient, ConcordDiagnostic } from "@applesauce/concord";
import { useEffect, useMemo, useRef, useState } from "react";

interface DiagnosticState {
  session: object;
  items: ConcordDiagnostic[];
  cleanup: ConcordDiagnostic[];
  retrying: boolean;
  retryError?: unknown;
}

function emptyState(session: object): DiagnosticState {
  return { session, items: [], cleanup: [], retrying: false };
}

/** Background publishes can fail after a send resolves locally. Keep that visible. */
export function ConcordDiagnostics({ client }: { client: ConcordClient }) {
  const session = useMemo(() => ({ client }), [client]);
  const lifecycle = useRef<{ session: object; active: boolean; pending: boolean } | undefined>(undefined);
  const [state, setState] = useState(() => emptyState(session));
  const current = state.session === session ? state : emptyState(session);
  useEffect(() => {
    const operation = { session, active: true, pending: false };
    lifecycle.current = operation;
    const sub = client.diagnostics$.subscribe((diagnostic) => {
      if (diagnostic.stage === "direct-invite-receive") return;
      setState((previous) => {
        const current = previous.session === session ? previous : emptyState(session);
        // Keep failed deletions actionable even if unrelated activity fills the journal.
        if (diagnostic.stage === "storage-cleanup") {
          const cleanup = current.cleanup.filter((item) =>
            item.communityId !== diagnostic.communityId || item.key !== diagnostic.key);
          return { ...current, cleanup: [...cleanup, diagnostic] };
        }
        return { ...current, items: [...current.items.slice(-4), diagnostic] };
      });
    });
    return () => {
      operation.active = false;
      sub.unsubscribe();
    };
  }, [client, session]);

  async function retryCleanup() {
    const operation = lifecycle.current;
    if (!operation?.active || operation.session !== session || operation.pending || !current.cleanup.length) return;
    operation.pending = true;
    const attempted = new Set(current.cleanup);
    setState((previous) => ({ ...previous, retrying: true, retryError: undefined }));
    try {
      await client.retryStorageCleanup();
      if (!operation.active) return;
      // The SDK reports failed deletions instead of rejecting. Remove only the old
      // diagnostics: failures emitted during this attempt must remain retryable.
      setState((previous) => previous.session !== session ? previous : {
        ...previous, cleanup: previous.cleanup.filter((item) => !attempted.has(item)),
      });
    } catch (error) {
      const retryError = error ?? new Error("Unknown cleanup retry failure");
      if (operation.active) setState((previous) =>
        previous.session !== session ? previous : { ...previous, retryError });
    } finally {
      operation.pending = false;
      if (operation.active) setState((previous) =>
        previous.session !== session ? previous : { ...previous, retrying: false });
    }
  }

  if (!current.items.length && !current.cleanup.length) return null;
  return <div role="alert" className="fixed top-3 right-3 z-50 max-w-sm alert alert-warning">
    <div>
      <p className="font-semibold">Community activity needs attention</p>
      {[...current.items, ...current.cleanup].map((item, index) => <p key={index} className="text-xs break-words">
        {item.stage}: {item.error instanceof Error ? item.error.message : String(item.error)}
      </p>)}
      {!!current.cleanup.length && <div className="mt-2">
        <p className="text-xs">Local data could not be deleted. Affected storage stays closed until cleanup succeeds. Retrying does not resend community activity.</p>
        <button className="btn btn-warning btn-xs mt-1" disabled={current.retrying} onClick={() => void retryCleanup()}>
          {current.retrying ? "Retrying local cleanup…" : "Retry local cleanup"}
        </button>
        {current.retryError !== undefined && <p className="text-xs break-words">
          Cleanup retry failed: {current.retryError instanceof Error ? current.retryError.message : String(current.retryError)}
        </p>}
      </div>}
    </div>
    <button className="btn btn-ghost btn-xs" disabled={current.retrying} onClick={() => setState(emptyState(session))}>Dismiss</button>
  </div>;
}
