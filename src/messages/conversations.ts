import type { WrappedMessagesClient, WrappedConversationSummary } from "applesauce-extra/messages";
import { getExpirationTimestamp, unixNow, type Rumor } from "applesauce-core/helpers";
import { Observable, Subscription } from "rxjs";

export type ConversationSource = Pick<WrappedMessagesClient,
  "conversations" | "conversationInserts$" | "conversationUpdates$" | "pubkey" | "rumorStore" | "conversation">;

/** Subscribe before enumeration so arrivals cannot disappear behind a stale page.
 * This is list presentation only; the SDK owns participant identity and indexing. */
export function conversationSummaries(client: ConversationSource) {
  return new Observable<WrappedConversationSummary[]>((subscriber) => {
    const abort = new AbortController();
    const entries = new Map<string, WrappedConversationSummary>();
    const removed = new Set<string>();
    const emit = () => subscriber.next([...entries.values()].sort((a, b) =>
      b.lastActivity - a.lastActivity || b.id.localeCompare(a.id)));
    const upsert = (summary: WrappedConversationSummary) => {
      if (summary.participants.length !== 2 || !summary.participants.includes(client.pubkey)) return;
      if (summary.lastMessage && (removed.has(summary.lastMessage.id) ||
        (getExpirationTimestamp(summary.lastMessage) ?? Infinity) <= unixNow())) return;
      const previous = entries.get(summary.id);
      if (previous && (previous.lastActivity > summary.lastActivity ||
        (previous.lastActivity === summary.lastActivity && previous.lastMessage &&
          (!summary.lastMessage || previous.lastMessage.id < summary.lastMessage.id)))) return;
      entries.set(summary.id, summary);
      emit();
    };
    const subscriptions = new Subscription();
    subscriptions.add(client.conversationInserts$.subscribe(upsert));
    subscriptions.add(client.conversationUpdates$.subscribe(upsert));
    // The SDK index records newest arrivals, but does not remove expired previews.
    // Refresh only the affected row from its SDK conversation, never re-fold messages.
    subscriptions.add(client.rumorStore.remove$.subscribe((message: Rumor) => {
      removed.add(message.id);
      for (const summary of entries.values()) {
        if (summary.lastMessage?.id !== message.id) continue;
        entries.delete(summary.id);
        emit();
        void client.conversation(summary.participants).getMessages({}, { signal: abort.signal }).then((messages) => {
          if (abort.signal.aborted || !messages.length) return;
          const latest = messages[0];
          upsert({ ...summary, lastMessage: latest, lastActivity: latest.created_at });
        }).catch((error) => { if (!abort.signal.aborted) subscriber.error(error); });
      }
    }));
    emit();
    void (async () => {
      for await (const summary of client.conversations({ signal: abort.signal })) {
        if (abort.signal.aborted) return;
        upsert(summary);
      }
    })().catch((error) => { if (!abort.signal.aborted) subscriber.error(error); });
    return () => { abort.abort(); subscriptions.unsubscribe(); };
  });
}
