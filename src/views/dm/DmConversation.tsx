import { useMemo, useState, type ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import { unixNow } from "applesauce-core/helpers";
import type { WrappedMessagesClient, WrappedMessagePublicationResult } from "applesauce-extra/messages";
import { catchError, defer, of } from "rxjs";
import { pendingPublication, publishConversationDraft } from "../../messages/publication";
import { syncErrors } from "../../messages/status";
import { DmComposer } from "./DmComposer";
import { DmHeader } from "./DmHeader";
import { DmMessageList } from "./DmMessageList";
import { DmSettingsDrawer } from "./DmSettingsDrawer";
import { EXPIRATIONS, DEFAULT_EXPIRATION, readStoredExpiration, type ExpirationValue, writeStoredExpiration } from "./utils";

export function DmConversation({ client, peer, mobileListButton }: { client: WrappedMessagesClient; peer: string; mobileListButton: ReactNode }) {
  const conversation = useMemo(() => client.conversation(peer), [client, peer]);
  const [since, setSince] = useState(() => unixNow() - 30 * 86400);
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastPublish, setLastPublish] = useState<readonly WrappedMessagePublicationResult[]>([]);
  const [expiration, setExpiration] = useState<ExpirationValue>(() => readStoredExpiration(client.pubkey, peer) ?? DEFAULT_EXPIRATION);
  const prepared = pendingPublication(conversation);
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const availability = use$(() => defer(() => client.discover({ recipients: conversation.participants, content: "" })).pipe(
    catchError((reason: unknown) => of(reason instanceof Error ? reason : new Error(String(reason)))),
  ), [client, conversation, discoveryAttempt]);
  const discoveryError = availability instanceof Error ? availability.message : availability && !availability.canSend
    ? "Every participant, including you, must advertise message inbox relays before sending." : "";

  async function send(text: string) {
    if (sending || (!prepared && (!text.trim() || availability instanceof Error || !availability?.canSend))) return false;
    const seconds = EXPIRATIONS.find((item) => item.value === expiration)?.seconds;
    const expiresAt = seconds ? unixNow() + seconds : undefined;
    setSending(true);
    setError("");
    try {
      const result = await publishConversationDraft(conversation, { content: text, expiration: expiresAt, envelopeExpiration: expiresAt });
      setLastPublish([...result.publications]);
      return true;
    } catch (reason) {
      setLastPublish([...(pendingPublication(conversation)?.publications ?? [])]);
      setError(reason instanceof Error ? reason.message : String(reason));
      return false;
    } finally { setSending(false); }
  }

  async function loadOlder() {
    const next = Math.max(0, since - 30 * 86400);
    setLoadingHistory(true);
    setError("");
    try {
      const status = await client.loadHistory({ since: next, until: since });
      setSince(next);
      if (syncErrors(status)) setError(syncErrors(status)!);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setLoadingHistory(false); }
  }

  return (
    <div className="flex-1 flex min-w-0 min-h-0 relative">
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <DmHeader peer={peer} mobileListButton={mobileListButton} onToggleSettings={() => setSettingsOpen((open) => !open)} />
        <button className="btn btn-ghost btn-xs shrink-0" disabled={loadingHistory || since === 0} onClick={() => void loadOlder()}>{loadingHistory ? "Loading…" : "Load older messages"}</button>
        <DmMessageList conversation={conversation} since={since} peer={peer} />
        {discoveryError && <div role="alert" className="px-3 text-warning text-xs">{discoveryError} <button className="btn btn-ghost btn-xs" onClick={() => setDiscoveryAttempt((value) => value + 1)}>Check again</button></div>}
        <DmComposer conversation={conversation} peer={peer} sending={sending}
          retry={!!prepared} unavailable={!prepared && (!(availability && !(availability instanceof Error) && availability.canSend))}
          error={error} onSend={send} />
      </div>
      {settingsOpen && <DmSettingsDrawer self={client.pubkey} peer={peer}
        selfRelays={availability && !(availability instanceof Error) ? [...(availability.recipients.find((item) => item.recipient === client.pubkey)?.relays ?? [])] : []}
        peerRelays={availability && !(availability instanceof Error) ? [...(availability.recipients.find((item) => item.recipient === peer)?.relays ?? [])] : []}
        expiration={expiration} onExpirationChange={(value) => { setExpiration(value); writeStoredExpiration(client.pubkey, peer, value); }}
        lastPublish={prepared?.publications ?? lastPublish} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
