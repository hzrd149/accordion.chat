import { useMemo, useState, type FormEvent, type ReactNode } from "react";
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
  const messageState = use$(() => conversation.timeline$({ since }).pipe(
    catchError((reason: unknown) => of(reason instanceof Error ? reason : new Error(String(reason)))),
  ), [conversation, since]);
  const messages = useMemo(() => Array.isArray(messageState) ? [...messageState].sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)) : [], [messageState]);
  const draft = use$(() => conversation.draft$.pipe(catchError((reason: unknown) => of(reason instanceof Error ? reason : new Error(String(reason))))), [conversation]);
  const [editedText, setEditedText] = useState<string>();
  const text = editedText ?? (draft instanceof Error ? "" : draft?.content) ?? "";
  const [sending, setSending] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lastPublish, setLastPublish] = useState<readonly WrappedMessagePublicationResult[]>([]);
  const [expiration, setExpiration] = useState<ExpirationValue>(() => readStoredExpiration(client.pubkey, peer) ?? DEFAULT_EXPIRATION);
  const publications = use$(client.publications$);
  const busy = use$(client.busy$);
  const prepared = pendingPublication(conversation);
  const publicationState = prepared ? publications?.[prepared.message.id] : undefined;
  const [discoveryAttempt, setDiscoveryAttempt] = useState(0);
  const availability = use$(() => defer(() => client.discover({ recipients: conversation.participants, content: "" })).pipe(
    catchError((reason: unknown) => of(reason instanceof Error ? reason : new Error(String(reason)))),
  ), [client, conversation, discoveryAttempt]);
  const discoveryError = availability instanceof Error ? availability.message : availability && !availability.canSend
    ? "Every participant, including you, must advertise message inbox relays before sending." : "";

  function changeText(content: string) {
    setEditedText(content);
    void conversation.setDraft({ content }).catch((reason: unknown) => setError(`Could not save draft: ${String(reason)}`));
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending || busy || (!prepared && (!text.trim() || availability instanceof Error || !availability?.canSend))) return;
    const seconds = EXPIRATIONS.find((item) => item.value === expiration)?.seconds;
    const expiresAt = seconds ? unixNow() + seconds : undefined;
    setSending(true);
    setError("");
    try {
      const result = await publishConversationDraft(conversation, { content: text, expiration: expiresAt, envelopeExpiration: expiresAt });
      setLastPublish([...result.publications]);
      setEditedText("");
    } catch (reason) {
      setLastPublish([...(pendingPublication(conversation)?.publications ?? [])]);
      setError(reason instanceof Error ? reason.message : String(reason));
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
        {messageState instanceof Error && <div role="alert" className="p-2 text-error">{messageState.message}</div>}
        <DmMessageList messages={messages} self={client.pubkey} peer={peer} />
        {discoveryError && <div role="alert" className="px-3 text-warning text-xs">{discoveryError} <button className="btn btn-ghost btn-xs" onClick={() => setDiscoveryAttempt((value) => value + 1)}>Check again</button></div>}
        <DmComposer peer={peer} text={text} sending={sending || !!busy || publicationState === "publishing"}
          retry={!!prepared} unavailable={!prepared && (!(availability && !(availability instanceof Error) && availability.canSend))}
          error={error || (draft instanceof Error ? draft.message : "")} onTextChange={changeText} onSubmit={send} />
      </div>
      {settingsOpen && <DmSettingsDrawer self={client.pubkey} peer={peer}
        selfRelays={availability && !(availability instanceof Error) ? [...(availability.recipients.find((item) => item.recipient === client.pubkey)?.relays ?? [])] : []}
        peerRelays={availability && !(availability instanceof Error) ? [...(availability.recipients.find((item) => item.recipient === peer)?.relays ?? [])] : []}
        expiration={expiration} onExpirationChange={(value) => { setExpiration(value); writeStoredExpiration(client.pubkey, peer, value); }}
        lastPublish={prepared?.publications ?? lastPublish} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
