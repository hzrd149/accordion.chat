import type { ReactNode } from "react";
import { MessageSquare } from "lucide-react";

export function DmEmpty({ mobileListButton }: { mobileListButton: ReactNode }) {
  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-base-100">
      <div className="h-12 flex items-center px-4 border-b border-base-300 shadow-sm shrink-0 md:hidden">
        {mobileListButton}
        <span className="font-semibold ml-2">DMs</span>
      </div>
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center text-base-content/60 gap-2 text-center p-10">
        <MessageSquare size={48} />
        <div>Select a 1:1 DM or start a new conversation.</div>
      </div>
    </div>
  );
}
