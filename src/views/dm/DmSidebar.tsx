import type { ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import type { WrappedMessagesClient } from "applesauce-extra/messages";
import { useNavigate } from "react-router";
import { Loader2, MessageSquare, Settings } from "lucide-react";
import { syncErrors } from "../../messages/status";
import { DmConversationList } from "./DmConversationList";

export function DmSidebar({
  open,
  mobileNav,
  client,
  selectedPeer,
  onClose,
}: {
  open: boolean;
  mobileNav: ReactNode;
  client: WrappedMessagesClient;
  selectedPeer: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const relays = use$(client.relays$);
  const status = use$(client.status$);
  const sync = use$(client.syncStatus$);
  const decryption = use$(client.decryptionState$);
  // Diagnostics live on the settings page; only flag that something needs attention.
  const attention = !!syncErrors(sync) || !!decryption?.failed.length || !!decryption?.locked;
  const openSettings = () => {
    navigate("/settings/dm");
    onClose();
  };

  return (
    <aside
      className={`w-72 shrink-0 bg-base-200 border-r border-base-300 flex flex-col min-h-0 max-md:w-[min(18rem,calc(100vw-4.5rem))] max-md:fixed max-md:inset-y-0 max-md:left-18 max-md:z-40 max-md:safe-fixed-y max-md:transition-transform ${
        open ? "max-md:translate-x-0" : "max-md:-translate-x-[calc(100%+4.5rem)]"
      }`}
    >
      <div className="h-12 flex items-center gap-2 px-3 border-b border-base-300 shrink-0">
        {mobileNav}
        <MessageSquare size={20} className="text-base-content/60" />
        <span className="font-semibold">DMs</span>
        {status === "loading" && <Loader2 size={14} className="animate-spin opacity-50" aria-label="Syncing" />}
        <div className="flex-1" />
        <button className="btn btn-ghost btn-sm btn-circle relative" title="DM settings" onClick={openSettings}>
          <Settings size={18} />
          {attention && <span className="status status-warning absolute top-1 right-1" />}
        </button>
      </div>
      {relays && relays.length === 0 && (
        <button className="m-2 mb-0 alert alert-warning alert-soft text-xs py-2 text-left" onClick={openSettings}>
          Set up DM relays so people can message you.
        </button>
      )}
      <DmConversationList
        client={client}
        onClose={onClose}
        selectedPeer={selectedPeer}
        onSelect={(conversationPeer) => {
          navigate(`/dm/${conversationPeer}`);
          onClose();
        }}
      />
    </aside>
  );
}
