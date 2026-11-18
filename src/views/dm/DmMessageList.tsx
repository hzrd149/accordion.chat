import type { Rumor } from "applesauce-common/helpers";
import type { WrappedConversation } from "applesauce-extra/messages";
import { use$ } from "applesauce-react/hooks";
import { catchError, of } from "rxjs";
import { UserAvatar, UserName } from "../../components/User";
import { formatTime } from "../../helpers/util";

export function DmMessageList({ conversation, since, peer, loadingOlder, canLoadOlder, onLoadOlder }: {
  conversation: WrappedConversation;
  since: number;
  peer: string;
  loadingOlder: boolean;
  canLoadOlder: boolean;
  onLoadOlder: () => void;
}) {
  const timeline = use$(() => conversation.timeline$({ since }).pipe(
    catchError((error: unknown) => of(error instanceof Error ? error : new Error(String(error)))),
  ), [conversation, since]);
  if (timeline instanceof Error) return <div role="alert" className="flex-1 p-2 text-error">{timeline.message}</div>;
  // The timeline is newest-first; `flex-col-reverse` renders it bottom-up, so the
  // scroll position starts (and stays pinned) at the newest message without JS.
  const messages = timeline ?? [];
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col-reverse gap-3">
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center text-base-content/60">
          {timeline ? <>No messages with <UserName pubkey={peer} /> yet.</> : "Loading messages…"}
        </div>
      ) : (
        messages.map((message) => <DmMessageBubble key={message.id} message={message} own={message.pubkey === conversation.client.pubkey} />)
      )}
      {canLoadOlder && (
        <button className="btn btn-ghost btn-xs self-center shrink-0" disabled={loadingOlder} onClick={onLoadOlder}>
          {loadingOlder ? "Loading…" : "Load older messages"}
        </button>
      )}
    </div>
  );
}

function DmMessageBubble({ message, own }: { message: Rumor; own: boolean }) {
  return (
    <div className={`chat ${own ? "chat-end" : "chat-start"}`}>
      <div className="chat-image"><UserAvatar pubkey={message.pubkey} className="w-9 h-9" /></div>
      <div className="chat-header text-xs opacity-70"><UserName pubkey={message.pubkey} /> <time>{formatTime(message.created_at * 1000)}</time></div>
      <div className="chat-bubble whitespace-pre-line break-words max-w-[min(32rem,75vw)]">
        {message.kind === 15 ? <span className="italic opacity-70">Encrypted attachment</span> : message.content}
      </div>
    </div>
  );
}
