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
    <>
      <section className="mt-10">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-lg font-bold flex-1">Inbox</h3>
          {client && (
            <button className="btn btn-ghost btn-sm gap-1" disabled={syncing || busy || !relayStatus?.length} onClick={() => void run(() => client.loadHistory())}>
              <RefreshCw size={14} className={syncing ? "animate-spin" : ""} /> {syncError ? "Retry sync" : "Refresh"}
            </button>
          )}
        </div>
        <p className="text-sm opacity-70 leading-relaxed mb-3">
          {!client ? "The message client is starting…"
            : `${syncing ? "Syncing" : status === "ready" ? "Up to date" : "Idle"}${sync ? ` — ${sync.loaded} encrypted message${sync.loaded === 1 ? "" : "s"} received` : ""}. `
              + "Accordion stays connected to your DM relays to receive new messages. Refresh if messages seem to be missing."}
        </p>
        {(clientError || error || syncError) && (
          <p role="alert" className="text-sm text-error mb-3 break-words">{clientError || error || syncError}</p>
        )}
        {!!relayStatus?.length && (
          <table className="table table-sm">
            <thead><tr><th>Relay</th><th className="w-32">Connection</th></tr></thead>
            <tbody>
              {relayStatus.map((relay) => {
                const state = relay.error ? "Error" : relay.connection?.connected ? "Connected" : "Disconnected";
                return (
                  <tr key={relay.url}>
                    <td className="font-mono text-xs break-all">{relay.url}</td>
                    <td>
                      <span className="inline-flex items-center gap-2 text-xs">
                        <span className={`status ${state === "Connected" ? "status-success" : state === "Error" ? "status-error" : "status-neutral"}`} />
                        {state}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {client && decryption && (
        <section className="mt-10">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-lg font-bold flex-1">Decryption</h3>
            {locked > 0 && (
              <button className="btn btn-primary btn-sm gap-1" disabled={unlocking} onClick={() => void run(() => client.unlock())}>
                <Lock size={14} /> {unlocking ? "Unlocking…" : `Unlock all (${locked})`}
              </button>
            )}
          </div>
          <p className="text-sm opacity-70 leading-relaxed mb-3">
            {decryption.unlocked} of {decryption.total} messages unlocked, {locked} locked, {failed.length} failed.
            Locked messages are waiting for your signer to decrypt them. Failed ones could not be opened and can be retried.
          </p>
          {failed.length > 0 && (
            <table className="table table-sm">
              <thead><tr><th>Failed message</th><th className="w-20" /></tr></thead>
              <tbody>
                {failed.map((id) => (
                  <tr key={id}>
                    <td className="font-mono text-xs">{id.slice(0, 16)}…</td>
                    <td className="text-right">
                      <button className="btn btn-ghost btn-xs" disabled={unlocking} onClick={() => void run(async () => {
                        const envelope = client.eventStore.getEvent(id);
                        if (!envelope) throw new Error("Message envelope is no longer cached. Refresh the inbox first.");
                        await client.retryDecryption(envelope);
                      })}>Retry</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="mt-10">
        <h3 className="text-lg font-bold mb-1">Restart</h3>
        <p className="text-sm opacity-70 leading-relaxed mb-3">
          Stops the message client and starts it again with fresh relay connections. Your messages and drafts are kept.
        </p>
        <button className="btn btn-sm gap-1" onClick={restartMessages}>
          <RotateCcw size={14} /> Restart message client
        </button>
      </section>
    </>
  );
}
