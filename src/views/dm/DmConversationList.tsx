import { Inbox } from "lucide-react";
import { UserAvatar, UserName } from "../../components/User";
import type { WrappedConversation, WrappedMessagesClient } from "applesauce-extra/messages";
import { use$ } from "applesauce-react/hooks";
import { catchError, of } from "rxjs";
import { conversationEntries } from "../../messages/conversations";
import { DmUserSearch } from "./DmUserSearch";

export function DmConversationList({
  client,
  onClose,
  selectedPeer,
  onSelect,
}: {
  client: WrappedMessagesClient;
  onClose: () => void;
  selectedPeer: string | null;
  onSelect: (peer: string) => void;
}) {
  const entries = use$(() => conversationEntries(client).pipe(
    catchError((error: unknown) => of(error instanceof Error ? error : new Error(String(error)))),
  ), [client]);
  const conversations = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.participants.length === 2 && entry.participants.includes(client.pubkey));
  return (
    <>
      <DmUserSearch self={client.pubkey} existingPeers={conversations.map((entry) => entry.participants.find((key) => key !== client.pubkey)!)} onPick={onClose} />
      <div className="flex-1 min-h-0 overflow-y-auto p-2">
        {entries instanceof Error ? <div role="alert" className="text-error">{entries.message}</div> : conversations.length === 0 ? (
          <div className="text-center text-xs opacity-60 py-10 px-3">
            <Inbox className="mx-auto mb-2" size={28} />
            No 1:1 conversations yet.
          </div>
        ) : (
          conversations.map((entry) => <DmConversationRow key={entry.id} conversation={client.conversation(entry.participants)} selectedPeer={selectedPeer} onSelect={onSelect} />)
        )}
      </div>
    </>
  );
}

function DmConversationRow({ conversation, selectedPeer, onSelect }: {
  conversation: WrappedConversation;
  selectedPeer: string | null;
  onSelect: (peer: string) => void;
}) {
  const timeline = use$(() => conversation.timeline$({}).pipe(
    catchError((error: unknown) => of(error instanceof Error ? error : new Error(String(error)))),
  ), [conversation]);
  const conversationPeer = conversation.participants.find((key) => key !== conversation.client.pubkey)!;
  const last = Array.isArray(timeline) ? timeline[0] : undefined;
  return (
    <button
      className={`w-full flex items-center gap-2 p-2 rounded-box text-left hover:bg-base-300 ${selectedPeer === conversationPeer ? "bg-base-300" : ""}`}
      onClick={() => onSelect(conversationPeer)}
    >
      <UserAvatar pubkey={conversationPeer} className="w-9 h-9" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate text-sm"><UserName pubkey={conversationPeer} /></div>
        <div className="text-xs opacity-60 truncate">{timeline instanceof Error ? timeline.message : last?.kind === 15 ? "Encrypted attachment" : last?.content || (timeline ? "No messages" : "Loading message…")}</div>
      </div>
      {last && <div className="text-[10px] opacity-50 shrink-0">{new Date(last.created_at * 1000).toLocaleDateString()}</div>}
    </button>
  );
}
