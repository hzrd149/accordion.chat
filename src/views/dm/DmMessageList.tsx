import { groupMessageEvents, type Rumor } from "applesauce-common/helpers";
import type { WrappedConversation } from "applesauce-extra/messages";
import { UserAvatar, UserName } from "../../components/User";
import { formatTime } from "../../helpers/util";
import { useDmFeed } from "../../hooks/use-dm-feed";

export function DmMessageList({ conversation, peer }: { conversation: WrappedConversation; peer: string }) {
  const { messages, loading, done, error, sentinel } = useDmFeed(conversation);
  if (messages instanceof Error) return <div role="alert" className="flex-1 p-2 text-error">{messages.message}</div>;
  // The timeline is newest-first; `flex-col-reverse` renders it bottom-up, so the
  // scroll position starts at the newest message, and older pages added at the
  // visual top don't move what the reader is looking at.
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col-reverse gap-3">
      {!messages?.length ? (
        <div className="flex-1 flex items-center justify-center text-center text-base-content/60">
          {messages ? <>No messages with <UserName pubkey={peer} /> yet.</> : "Loading messages…"}
        </div>
      ) : (
        groupMessageEvents(messages).map((group) => (
          <DmMessageGroup key={group[0].id} messages={group} own={group[0].pubkey === conversation.client.pubkey} />
        ))
      )}
      <div ref={sentinel} className="shrink-0 min-h-6 flex items-center justify-center gap-2 text-xs text-base-content/60">
        {loading ? <><span className="loading loading-spinner loading-xs" /> Loading older messages…</>
          : error ? <span role="alert" className="text-error">{error} Retrying shortly.</span>
          : done && messages?.length ? "Beginning of conversation" : null}
      </div>
    </div>
  );
}

/** A run of consecutive messages from one author within five minutes (the
 * applesauce `groupMessageEvents` rule noStrudel uses). The group is newest-first,
 * so it renders column-reverse: the oldest message sits on top and carries the
 * name/time header; the newest, bottom bubble carries the avatar and tail. */
function DmMessageGroup({ messages, own }: { messages: Rumor[]; own: boolean }) {
  return (
    <div className="flex flex-col-reverse">
      {messages.map((message, i) => (
        <DmMessageBubble key={message.id} message={message} own={own} header={i === messages.length - 1} tail={i === 0} />
      ))}
    </div>
  );
}

function DmMessageBubble({ message, own, header, tail }: { message: Rumor; own: boolean; header: boolean; tail: boolean }) {
  return (
    <div className={`chat ${own ? "chat-end" : "chat-start"} py-0.5`} title={header ? undefined : formatTime(message.created_at * 1000)}>
      <div className="chat-image w-9">{tail && <UserAvatar pubkey={message.pubkey} className="w-9 h-9" />}</div>
      {header && <div className="chat-header text-xs opacity-70"><UserName pubkey={message.pubkey} /> <time>{formatTime(message.created_at * 1000)}</time></div>}
      <div className={`chat-bubble whitespace-pre-line break-words max-w-[min(32rem,75vw)] ${tail ? "" : "before:hidden rounded-field"}`}>
        {message.kind === 15 ? <span className="italic opacity-70">Encrypted attachment</span> : message.content}
      </div>
    </div>
  );
}
