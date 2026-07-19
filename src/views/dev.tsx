import type { ReactNode } from "react";
import { History, Landmark, Wrench } from "lucide-react";
import { CryptoHistory } from "../components/dev/CryptoHistory";
import { ControlPlaneDebugger } from "../components/dev/ControlPlaneDebugger";

/**
 * Developer tools — surfaced only when developer mode is enabled (see
 * `src/lib/dev-mode.ts`). Mirrors the Settings layout: a left sub-nav of tools +
 * a content pane, with page selection delegated back to the Shell via
 * `onSelectPage` → `navigate("/dev/:page")`. Add new tools by extending `PAGES`.
 */
type PageId = "crypto-history" | "control-plane";

const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "crypto-history", label: "Group Crypto History", icon: <History size={18} /> },
  { id: "control-plane", label: "Control Plane Debugger", icon: <Landmark size={18} /> },
];

export function DevView({
  page: pageParam,
  mobileNav,
  onSelectPage,
}: {
  page: string;
  mobileNav: ReactNode;
  onSelectPage: (page: PageId) => void;
}) {
  // Fall back to the first tool for an unknown/empty page value.
  const page: PageId = PAGES.some((p) => p.id === pageParam) ? (pageParam as PageId) : "crypto-history";
  const active = PAGES.find((p) => p.id === page)!;

  return (
    <div className="flex-1 flex min-w-0 bg-base-100 max-md:flex-col">
      <nav className="w-58 shrink-0 bg-base-200 p-3 overflow-y-auto flex flex-col gap-0.5 max-md:w-full max-md:safe-topnav max-md:flex-row max-md:items-center max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-base-300">
        {mobileNav}
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-3 text-[11px] uppercase font-bold tracking-wide text-base-content/60 max-md:p-0 max-md:pr-1 max-md:shrink-0">
          <Wrench size={18} />
          <span className="max-md:hidden">Developer</span>
        </div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`btn btn-ghost justify-start gap-2.5 w-full font-medium max-md:w-auto max-md:shrink-0 ${page === p.id ? "btn-active" : ""}`}
            onClick={() => onSelectPage(p.id)}
          >
            {p.icon}
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-12 flex items-center px-4 gap-2 border-b border-base-300 shadow-sm shrink-0">
          <span className="text-base-content/60">{active.icon}</span>
          <span className="font-semibold text-base-content">{active.label}</span>
        </div>
        <div className="flex-1 overflow-y-auto p-8 text-base max-md:px-4 max-md:py-6">
          <div className="w-full">
            {page === "crypto-history" && <CryptoHistory />}
            {page === "control-plane" && <ControlPlaneDebugger />}
          </div>
        </div>
      </div>
    </div>
  );
}
