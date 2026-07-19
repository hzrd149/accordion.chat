import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import { UserAvatar, UserName } from "../../components/User";
import { shortNpub } from "../../lib/util";

export function DmHeader({
  peer,
  mobileListButton,
  onToggleSettings,
}: {
  peer: string;
  mobileListButton: ReactNode;
  onToggleSettings: () => void;
}) {
  return (
    <div className="h-12 safe-topbar flex items-center gap-2 px-4 border-b border-base-300 shadow-sm shrink-0">
      {mobileListButton}
      <UserAvatar pubkey={peer} className="w-8 h-8" />
      <div className="font-semibold truncate"><UserName pubkey={peer} /></div>
      <div className="text-xs opacity-50 font-mono max-sm:hidden">{shortNpub(peer)}</div>
      <div className="flex-1" />
      <button className="btn btn-ghost btn-sm btn-circle" title="DM settings" onClick={onToggleSettings}>
        <Settings size={18} />
      </button>
    </div>
  );
}
