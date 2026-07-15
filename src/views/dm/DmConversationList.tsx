import { Inbox } from "lucide-react";
import { UserAvatar, UserName } from "../../components/User";
import type { ConversationPreview } from "./types";

export function DmConversationList({
  conversations,
  selectedPeer,
  onSelect,
}: {
  conversations: ConversationPreview[];
  selectedPeer: string | null;
  onSelect: (peer: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2">
      {conversations.length === 0 ? (
        <div className="text-center text-xs opacity-60 py-10 px-3">
          <Inbox className="mx-auto mb-2" size={28} />
          No 1:1 conversations yet.
        </div>
      ) : (
        conversations.map(([conversationPeer, last]) => (
          <button
            key={conversationPeer}
            className={`w-full flex items-center gap-2 p-2 rounded-box text-left hover:bg-base-300 ${selectedPeer === conversationPeer ? "bg-base-300" : ""}`}
            onClick={() => onSelect(conversationPeer)}
          >
            <UserAvatar pubkey={conversationPeer} className="w-9 h-9" />
            <div className="min-w-0 flex-1">
              <div className="font-semibold truncate text-sm"><UserName pubkey={conversationPeer} /></div>
              <div className="text-xs opacity-60 truncate">{last.content || "Encrypted message"}</div>
            </div>
            <div className="text-[10px] opacity-50 shrink-0">{new Date(last.created_at * 1000).toLocaleDateString()}</div>
          </button>
        ))
      )}
    </div>
  );
}
