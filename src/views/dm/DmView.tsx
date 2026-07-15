import { useEffect, useMemo, type ReactNode } from "react";
import { useParams } from "react-router";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { Menu } from "lucide-react";
import { userFor } from "../../lib/settings-actions";
import { DmConversation } from "./DmConversation";
import { DmEmpty } from "./DmEmpty";
import { DmSidebar } from "./DmSidebar";
import { useConversations, useDmInbox } from "./hooks";
import { isHexPubkey } from "./utils";

export function DmView({
  mobileNav,
  mobileNavOpen,
  onOpenMobileNav,
  onCloseMobileNav,
}: {
  mobileNav: ReactNode;
  mobileNavOpen: boolean;
  onOpenMobileNav: () => void;
  onCloseMobileNav: () => void;
}) {
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const user = useMemo(() => userFor(pubkey), [pubkey]);
  const relays = use$(() => user.directMessageRelays$, [user]);
  const { peerPubkey } = useParams();
  const peer = peerPubkey && isHexPubkey(peerPubkey) ? peerPubkey.toLowerCase() : null;
  const { messages, locked, syncs, unlocking, unlockAll, startTransition } = useDmInbox(account, pubkey, relays);
  const conversations = useConversations(pubkey, messages);

  useEffect(() => {
    if (locked.length === 0 || unlocking) return;
    startTransition(() => {
      void unlockAll();
    });
  }, [locked.length, startTransition, unlockAll, unlocking]);

  if (!account) return null;

  const mobileListButton = (
    <button className="btn btn-ghost btn-sm btn-circle shrink-0 md:hidden" title="DM list" onClick={onOpenMobileNav}>
      <Menu size={22} />
    </button>
  );

  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-base-100 relative overflow-hidden">
      <DmSidebar
        open={mobileNavOpen}
        mobileNav={mobileNav}
        pubkey={pubkey}
        relays={relays}
        syncs={syncs}
        lockedCount={locked.length}
        unlocking={unlocking}
        conversations={conversations}
        selectedPeer={peer}
        onClose={onCloseMobileNav}
        onUnlockAll={() => void unlockAll()}
      />
      {peer ? <DmConversation self={pubkey} peer={peer} mobileListButton={mobileListButton} /> : <DmEmpty mobileListButton={mobileListButton} />}
    </div>
  );
}
