import type { ReactNode } from "react";
import { History, Wrench } from "lucide-react";
import { CryptoHistory } from "../components/dev/CryptoHistory";

/**
 * Developer tools — surfaced only when developer mode is enabled (see
 * `src/lib/dev-mode.ts`). Mirrors the Settings layout: a left sub-nav of tools +
 * a content pane, with page selection delegated back to the Shell via
 * `onSelectPage` → `navigate("/dev/:page")`. Add new tools by extending `PAGES`.
 */
type PageId = "crypto-history";

const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "crypto-history", label: "Group Crypto History", icon: <History size={18} /> },
];

export function DevView({
  page: pageParam,
  onSelectPage,
}: {
  page: string;
  onSelectPage: (page: PageId) => void;
}) {
  // Fall back to the first tool for an unknown/empty page value.
  const page: PageId = PAGES.some((p) => p.id === pageParam) ? (pageParam as PageId) : "crypto-history";

  return (
    <div className="flex-1 flex min-w-0 bg-base-100 max-md:flex-col">
      <nav className="w-58 shrink-0 bg-base-200 p-3 overflow-y-auto flex flex-col gap-0.5 max-md:w-full max-md:flex-row max-md:items-center max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-base-300 max-md:pl-14">
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
      <div className="flex-1 relative overflow-y-auto p-10 max-md:px-4 max-md:py-6">
        <div className="max-w-[720px]">{page === "crypto-history" && <CryptoHistory />}</div>
      </div>
    </div>
  );
}
