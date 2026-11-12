import type { WrappedMessagesClient, WrappedConversationSummary } from "applesauce-extra/messages";
import { defer, merge, scan, startWith } from "rxjs";

export type ConversationSource = Pick<WrappedMessagesClient,
  "conversations" | "conversationInserts$" | "conversationUpdates$">;
type ConversationEntry = Pick<WrappedConversationSummary, "id" | "participants" | "lastActivity">;

/** The SDK exposes enumeration plus deltas, rather than a list observable.
 * Keep only index entries here; conversation timelines own preview contents. */
export function conversationEntries(client: ConversationSource) {
  return merge(client.conversationInserts$, client.conversationUpdates$, defer(() => client.conversations())).pipe(
    scan((entries: ConversationEntry[], { id, participants, lastActivity }) => {
      const entry = { id, participants, lastActivity };
      const previous = entries.find((item) => item.id === entry.id);
      // A live update can arrive before an older enumeration page.
      if (previous && previous.lastActivity >= entry.lastActivity) return entries;
      return [...entries.filter((item) => item.id !== entry.id), entry]
        .sort((a, b) => b.lastActivity - a.lastActivity || b.id.localeCompare(a.id));
    }, []),
    startWith([] as ConversationEntry[]),
  );
}
