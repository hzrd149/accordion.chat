import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Lock, MessageSquare } from "lucide-react";
import type { ConversationPreview } from "./types";
import { DmConversationList } from "./DmConversationList";
import { DmUserSearch } from "./DmUserSearch";

export function DmSidebar({
  open,
  mobileNav,
  pubkey,
  relays,
  syncs,
  lockedCount,
  unlocking,
  conversations,
  selectedPeer,
  onClose,
  onUnlockAll,
}: {
  open: boolean;
  mobileNav: ReactNode;
  pubkey: string;
  relays: string[] | undefined;
  syncs: number;
  lockedCount: number;
  unlocking: boolean;
  conversations: ConversationPreview[];
  selectedPeer: string | null;
  onClose: () => void;
  onUnlockAll: () => void;
}) {
  const navigate = useNavigate();

  return (
    <aside
      className={`w-72 shrink-0 bg-base-200 border-r border-base-300 flex flex-col min-h-0 max-md:w-[min(18rem,calc(100vw-4.5rem))] max-md:fixed max-md:inset-y-0 max-md:left-18 max-md:z-40 max-md:transition-transform ${
        open ? "max-md:translate-x-0" : "max-md:-translate-x-[calc(100%+4.5rem)]"
      }`}
    >
      <div className="h-12 flex items-center gap-2 px-3 border-b border-base-300 shrink-0">
        {mobileNav}
        <MessageSquare size={20} className="text-base-content/60" />
        <span className="font-semibold">DMs</span>
      </div>
      <div className="p-3 border-b border-base-300 text-xs opacity-70 flex flex-col gap-2 shrink-0">
        <div>{relays?.length ? `${relays.length} DM relay${relays.length === 1 ? "" : "s"}` : "No DM relays configured"}</div>
        <div>{syncs} syncs • {lockedCount} locked</div>
        {lockedCount > 0 && (
          <button className="btn btn-primary btn-xs gap-1" onClick={onUnlockAll} disabled={unlocking}>
            <Lock size={13} /> {unlocking ? "Unlocking..." : `Unlock all (${lockedCount})`}
          </button>
        )}
        {!relays?.length && (
          <button className="btn btn-ghost btn-xs" onClick={() => navigate("/settings/dm")}>
            Configure DM relays
          </button>
        )}
      </div>
      <DmUserSearch
        self={pubkey}
        existingPeers={conversations.map(([conversationPeer]) => conversationPeer)}
        onPick={onClose}
      />
      <DmConversationList
        conversations={conversations}
        selectedPeer={selectedPeer}
        onSelect={(conversationPeer) => {
          navigate(`/dm/${conversationPeer}`);
          onClose();
        }}
      />
    </aside>
  );
}
