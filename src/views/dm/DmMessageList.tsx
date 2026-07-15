import type { Rumor } from "applesauce-common/helpers";
import { UserAvatar, UserName } from "../../components/User";
import { formatTime } from "../../lib/util";

export function DmMessageList({ messages, self, peer }: { messages: Rumor[]; self: string; peer: string }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-4 flex flex-col gap-3">
      {messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-center text-base-content/60">
          No messages with <UserName pubkey={peer} /> yet.
        </div>
      ) : (
        messages.map((message) => <DmMessageBubble key={message.id} message={message} own={message.pubkey === self} />)
      )}
    </div>
  );
}

function DmMessageBubble({ message, own }: { message: Rumor; own: boolean }) {
  return (
    <div className={`chat ${own ? "chat-end" : "chat-start"}`}>
      <div className="chat-image"><UserAvatar pubkey={message.pubkey} className="w-9 h-9" /></div>
      <div className="chat-header text-xs opacity-70"><UserName pubkey={message.pubkey} /> <time>{formatTime(message.created_at * 1000)}</time></div>
      <div className="chat-bubble whitespace-pre-line break-words max-w-[min(32rem,75vw)]">{message.content}</div>
    </div>
  );
}
