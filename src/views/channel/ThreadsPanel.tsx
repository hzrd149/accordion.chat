import { useMemo } from "react";
import { MessageSquare } from "lucide-react";
import { useCommunity } from "../../hooks/use-community";
import { useMessages } from "../../chat/useMessages";
import { clockTime, colorFor } from "../../helpers/util";
import { UserAvatar, UserName } from "../../components/User";
import type { Emoji } from "../../helpers/emoji";
import type { ChatMessage } from "../../chat/fold";
import { ThreadView } from "./ThreadView";

export function ThreadsPanel({
  cid,
  channelId,
  threadRootId,
  canWrite,
  favorites,
  onOpenThread,
  onCloseThread,
}: {
  cid: string;
  channelId: string;
  threadRootId: string | null;
  canWrite: boolean;
  favorites: Emoji[];
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
}) {
  const community = useCommunity(cid);
  const messages = useMessages(community, channelId);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const roots = useMemo(() => messages.filter((m) => m.threadReplyCount > 0), [messages]);
  const root = threadRootId ? byId.get(threadRootId) ?? null : null;

  if (root) {
    return (
      <ThreadView
        cid={cid}
        channelId={channelId}
        root={root}
        canWrite={canWrite}
        favorites={favorites}
        onBack={onCloseThread}
      />
    );
  }
  return <ThreadIndex roots={roots} onOpen={(m) => onOpenThread(m.id)} />;
}

function ThreadIndex({ roots, onOpen }: { roots: ChatMessage[]; onOpen: (m: ChatMessage) => void }) {
  if (roots.length === 0)
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center text-base-content/60 p-4">
        <MessageSquare size={36} />
        <div className="text-base-content font-bold">No threads yet.</div>
        <p className="m-0 max-w-[220px] text-[13px]">Use “Reply in thread” on a message to start one.</p>
      </div>
    );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-4">
      {roots.map((root) => (
        <button
          className="w-full flex gap-3 rounded-lg p-2 text-left hover:bg-base-300/60"
          key={root.id}
          onClick={() => onOpen(root)}
        >
          <UserAvatar pubkey={root.author} className="w-9 h-9 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold truncate" style={{ color: colorFor(root.author) }}>
                <UserName pubkey={root.author} />
              </span>
              <span className="text-[11px] text-base-content/60 shrink-0 ml-auto">{clockTime(root.ms)}</span>
            </div>
            <div className="mt-0.5 text-sm leading-snug text-base-content/80 line-clamp-2 break-words">
              {root.deleted ? "(message deleted)" : (root.edited ?? root.content) || "message"}
            </div>
            <div className="mt-1 text-primary text-[13px] font-semibold">
              {root.threadReplyCount} {root.threadReplyCount === 1 ? "reply" : "replies"}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
