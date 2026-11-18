import { useState } from "react";
import { use$ } from "applesauce-react/hooks";
import { Lock, RefreshCw, RotateCcw } from "lucide-react";
import { messagesClient$, messagesError$, restartMessages } from "../../services/messages";
import { syncErrors } from "../../messages/status";

/** Maintenance view for the NIP-17 gift-wrap client: inbox connections,
 * history sync, decryption backlog and client restart. Lives on the DM
 * settings page so the conversation list stays free of diagnostics. */
export function DmClientStatus() {
  const client = use$(messagesClient$);
  const clientError = use$(messagesError$);
  const status = use$(() => client?.status$, [client]);
  const relayStatus = use$(() => client?.relayStatus$, [client]);
  const sync = use$(() => client?.syncStatus$, [client]);
  const decryption = use$(() => client?.decryptionState$, [client]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const syncing = status === "loading";
  const syncError = syncErrors(sync);
  const locked = decryption?.locked ?? 0;
  const failed = decryption?.failed ?? [];
  const unlocking = busy || !!decryption?.pending;

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-bold flex-1">Message client</h3>
        <button className="btn btn-ghost btn-sm gap-1" onClick={restartMessages} title="Stop and restart the message client">
          <RotateCcw size={15} /> Restart
        </button>
      </div>
      <p className="text-sm opacity-70 leading-relaxed mb-4">
        Status of the encrypted inbox on this device. Use these tools if messages seem to be missing.
      </p>
      {clientError && <div role="alert" className="alert alert-error mb-4 text-sm">{clientError}</div>}
      {error && <div role="alert" className="alert alert-error mb-4 text-sm">{error}</div>}
      {!client ? (
        <p className="text-sm opacity-60" role="status">Message client is starting…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-box bg-base-200 border border-base-300 p-4">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">Inbox sync</div>
                <div className="text-xs opacity-70">
                  {syncing ? "Syncing…" : status === "ready" ? "Up to date" : status ?? "Idle"}
                  {sync ? ` • ${sync.loaded} envelope${sync.loaded === 1 ? "" : "s"} received` : ""}
                </div>
              </div>
              <button className="btn btn-sm gap-1" disabled={syncing || busy || !relayStatus?.length} onClick={() => void run(() => client.loadHistory())}>
                <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> {syncError ? "Retry sync" : "Refresh inbox"}
              </button>
            </div>
            {syncError && <div role="alert" className="text-error text-xs mt-2 break-words">{syncError}</div>}
            {!!relayStatus?.length && (
              <ul className="mt-3 flex flex-col gap-1">
                {relayStatus.map((relay) => {
                  const state = relay.error ? "error" : relay.connection?.connected ? "connected" : "disconnected";
                  return (
                    <li key={relay.url} className="flex items-center gap-2 text-xs min-w-0">
                      <span className={`status ${state === "connected" ? "status-success" : state === "error" ? "status-error" : "status-neutral"}`} />
                      <span className="font-mono truncate flex-1">{relay.url}</span>
                      <span className="opacity-60 shrink-0">{state}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div className="rounded-box bg-base-200 border border-base-300 p-4">
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="font-semibold text-sm">Decryption</div>
                <div className="text-xs opacity-70">
                  {decryption ? `${decryption.unlocked} of ${decryption.total} unlocked • ${locked} locked • ${failed.length} failed` : "—"}
                </div>
              </div>
              {locked > 0 && (
                <button className="btn btn-primary btn-sm gap-1" disabled={unlocking} onClick={() => void run(() => client.unlock())}>
                  <Lock size={14} /> {unlocking ? "Unlocking…" : `Unlock all (${locked})`}
                </button>
              )}
            </div>
            {failed.length > 0 && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer">{failed.length} message{failed.length === 1 ? "" : "s"} could not be decrypted</summary>
                <div className="max-h-48 overflow-y-auto mt-2 flex flex-col gap-1">
                  {failed.map((id) => (
                    <div key={id} className="flex items-center justify-between gap-2">
                      <span className="font-mono truncate">{id.slice(0, 16)}…</span>
                      <button className="btn btn-ghost btn-xs" disabled={unlocking} onClick={() => void run(async () => {
                        const envelope = client.eventStore.getEvent(id);
                        if (!envelope) throw new Error("Message envelope is no longer cached. Refresh the inbox first.");
                        await client.retryDecryption(envelope);
                      })}>Retry</button>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
