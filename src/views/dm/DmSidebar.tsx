import { useState, type ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import type { WrappedMessagesClient } from "applesauce-extra/messages";
import { useNavigate } from "react-router";
import { Lock, MessageSquare } from "lucide-react";
import { syncErrors } from "../../messages/status";
import { DmConversationList } from "./DmConversationList";

export function DmSidebar({
  open,
  mobileNav,
  client,
  selectedPeer,
  onClose,
}: {
  open: boolean;
  mobileNav: ReactNode;
  client: WrappedMessagesClient;
  selectedPeer: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const relays = use$(client.relays$);
  const status = use$(client.status$);
  const sync = use$(client.syncStatus$);
  const decryption = use$(client.decryptionState$);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const syncing = status === "loading";
  const unlocking = busy || !!decryption?.pending;
  const lockedCount = decryption?.locked ?? 0;
  const failed = decryption?.failed ?? [];
  const syncError = error || syncErrors(sync);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  return (
    <aside
      className={`w-72 shrink-0 bg-base-200 border-r border-base-300 flex flex-col min-h-0 max-md:w-[min(18rem,calc(100vw-4.5rem))] max-md:fixed max-md:inset-y-0 max-md:left-18 max-md:z-40 max-md:safe-fixed-y max-md:transition-transform ${
        open ? "max-md:translate-x-0" : "max-md:-translate-x-[calc(100%+4.5rem)]"
      }`}
    >
      <div className="h-12 flex items-center gap-2 px-3 border-b border-base-300 shrink-0">
        {mobileNav}
        <MessageSquare size={20} className="text-base-content/60" />
        <span className="font-semibold">DMs</span>
      </div>
      <div className="p-3 border-b border-base-300 text-xs opacity-70 flex flex-col gap-2 shrink-0">
        <div>{relays?.length ? `${relays.length} DM relay${relays.length === 1 ? "" : "s"}` : "No DM relays configured"}</div>
        <div>{syncing ? "Syncing…" : `${sync?.loaded ?? 0} received`} • {lockedCount} locked</div>
        {syncError && <div role="alert" className="text-error">{syncError}</div>}
        {!!relays?.length && (
          <button className="btn btn-ghost btn-xs" onClick={() => void run(() => client.loadHistory())} disabled={syncing || busy}>
            {syncError ? "Retry sync" : "Refresh inbox"}
          </button>
        )}
        {lockedCount > 0 && (
          <button className="btn btn-primary btn-xs gap-1" onClick={() => void run(() => client.unlock())} disabled={unlocking}>
            <Lock size={13} /> {unlocking ? "Unlocking..." : `Unlock all (${lockedCount})`}
          </button>
        )}
        {failed.length > 0 && <details>
          <summary>{failed.length} messages could not be decrypted</summary>
          <div className="max-h-32 overflow-y-auto">
            {failed.map((id) => <div key={id} className="flex items-center justify-between gap-2">
              <span className="font-mono truncate">{id.slice(0, 12)}…</span>
              <button className="btn btn-ghost btn-xs" disabled={unlocking} onClick={() => void run(async () => {
                const envelope = client.eventStore.getEvent(id);
                if (!envelope) throw new Error("Message envelope is no longer cached. Refresh the inbox first.");
                await client.retryDecryption(envelope);
              })}>Retry</button>
            </div>)}
          </div>
        </details>}
        {!relays?.length && (
          <button className="btn btn-ghost btn-xs" onClick={() => navigate("/settings/dm")}>
            Configure DM relays
          </button>
        )}
      </div>
      <DmConversationList
        client={client}
        onClose={onClose}
        selectedPeer={selectedPeer}
        onSelect={(conversationPeer) => {
          navigate(`/dm/${conversationPeer}`);
          onClose();
        }}
      />
    </aside>
  );
}
