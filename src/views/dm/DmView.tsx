import type { ReactNode } from "react";
import { useParams } from "react-router";
import { use$ } from "applesauce-react/hooks";
import { Menu } from "lucide-react";
import { messagesClient$ } from "../../services/messages";
import { DmConversation } from "./DmConversation";
import { DmAuthNotice } from "./DmAuthNotice";
import { DmEmpty } from "./DmEmpty";
import { DmSidebar } from "./DmSidebar";
import { isHexPubkey } from "./utils";

export function DmView({ mobileNav, mobileNavOpen, onOpenMobileNav, onCloseMobileNav }: {
  mobileNav: ReactNode;
  mobileNavOpen: boolean;
  onOpenMobileNav: () => void;
  onCloseMobileNav: () => void;
}) {
  const client = use$(messagesClient$);
  const { peerPubkey } = useParams();
  const peer = peerPubkey && isHexPubkey(peerPubkey) ? peerPubkey.toLowerCase() : null;
  if (!client) return <div className="p-4" role="status">Starting messages…</div>;
  const mobileListButton = <button className="btn btn-ghost btn-sm btn-circle shrink-0 md:hidden" title="DM list" onClick={onOpenMobileNav}><Menu size={22} /></button>;
  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-base-100 relative overflow-hidden">
      <DmSidebar key={client.pubkey} client={client} open={mobileNavOpen} mobileNav={mobileNav} selectedPeer={peer} onClose={onCloseMobileNav} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <DmAuthNotice key={client.pubkey} client={client} />
        {peer ? <DmConversation key={`${client.pubkey}:${peer}`} client={client} peer={peer} mobileListButton={mobileListButton} /> : <DmEmpty mobileListButton={mobileListButton} />}
      </div>
    </div>
  );
}
