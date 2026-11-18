import type { ConcordClient, ConcordDiagnostic } from "@applesauce/concord";
import { useEffect, useState } from "react";

/** Background publishes can fail after a send resolves locally. Keep that visible. */
export function ConcordDiagnostics({ client }: { client: ConcordClient }) {
  const [items, setItems] = useState<ConcordDiagnostic[]>([]);
  useEffect(() => {
    const sub = client.diagnostics$.subscribe((diagnostic) => {
      if (diagnostic.stage === "direct-invite-receive") return;
      setItems((previous) => [...previous.slice(-4), diagnostic]);
    });
    return () => sub.unsubscribe();
  }, [client]);
  if (!items.length) return null;
  return <div role="alert" className="fixed top-3 right-3 z-50 max-w-sm alert alert-warning">
    <div>
      <p className="font-semibold">Community activity needs attention</p>
      {items.map((item, index) => <p key={index} className="text-xs break-words">
        {item.stage}: {item.error instanceof Error ? item.error.message : String(item.error)}
      </p>)}
    </div>
    <button className="btn btn-ghost btn-xs" onClick={() => setItems([])}>Dismiss</button>
  </div>;
}
