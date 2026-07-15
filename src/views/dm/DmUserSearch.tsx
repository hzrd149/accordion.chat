import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { Loader2, Search, X } from "lucide-react";
import { UserAvatar, UserName } from "../../components/User";
import { getOpenRankingProvider, searchOpenRankingPubkeys, type OpenRankingPubkeyResult } from "../../lib/open-ranking";
import { shortNpub } from "../../lib/util";
import type { UserSearchResult } from "./types";
import { dedupeSearchResults, normalizePubkey } from "./utils";

export function DmUserSearch({ self, existingPeers, onPick }: { self: string; existingPeers: string[]; onPick: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [globalResults, setGlobalResults] = useState<OpenRankingPubkeyResult[]>([]);
  const [searchingQuery, setSearchingQuery] = useState<string | null>(null);
  const [error, setError] = useState("");
  const provider = getOpenRankingProvider();
  const existing = useMemo(() => new Set(existingPeers), [existingPeers]);

  useEffect(() => {
    const exact = normalizePubkey(query);
    const q = query.trim();
    if (!q || exact) return;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchingQuery(q);
      searchOpenRankingPubkeys(q, { limit: 12 })
        .then((res) => {
          if (!cancelled) {
            setGlobalResults(res.results);
            setError("");
          }
        })
        .catch((e) => {
          if (!cancelled) {
            setGlobalResults([]);
            setError(e instanceof Error ? e.message : "Global search failed");
          }
        })
        .finally(() => {
          if (!cancelled) setSearchingQuery((current) => (current === q ? null : current));
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const results = useMemo(() => {
    const exact = normalizePubkey(query);
    const exactResult = exact && exact !== self ? [{ pubkey: exact, existing: existing.has(exact) } satisfies UserSearchResult] : [];
    const openRankingResults = query.trim() && !exact
      ? globalResults
          .filter((result) => result.pubkey !== self)
          .map((result): UserSearchResult => ({ pubkey: result.pubkey, rank: result.rank, existing: existing.has(result.pubkey) }))
      : [];
    return dedupeSearchResults([...exactResult, ...openRankingResults]);
  }, [existing, globalResults, query, self]);

  const searching = searchingQuery === query.trim();

  return (
    <div className="p-2 border-b border-base-300 shrink-0">
      <label className="input input-bordered input-sm flex items-center gap-2">
        <Search size={15} className="opacity-60" />
        <input
          className="grow min-w-0"
          value={query}
          placeholder="Search users or paste npub"
          onChange={(e) => setQuery(e.target.value)}
        />
        {searching && <Loader2 size={15} className="animate-spin opacity-60" />}
        {query && (
          <button className="btn btn-ghost btn-xs btn-circle" type="button" onClick={() => setQuery("")}>
            <X size={13} />
          </button>
        )}
      </label>
      {query.trim() && (
        <div className="mt-2 rounded-box border border-base-300 bg-base-100 overflow-hidden">
          <div className="px-3 py-2 text-[11px] opacity-60 border-b border-base-300">
            Global search via {provider}
          </div>
          {error && <div className="px-3 py-2 text-xs text-error">{error}</div>}
          {!error && results.length === 0 ? (
            <div className="px-3 py-4 text-xs opacity-60 text-center">
              {searching ? "Searching..." : "No users found."}
            </div>
          ) : (
            results.map((result) => (
              <button
                key={result.pubkey}
                className="w-full text-left flex items-center gap-2 p-2 border-b border-base-300 last:border-b-0 hover:bg-base-200"
                onClick={() => {
                  setQuery("");
                  navigate(`/dm/${result.pubkey}`);
                  onPick();
                }}
              >
                <UserAvatar pubkey={result.pubkey} className="w-8 h-8" />
                <span className="min-w-0 flex-1">
                  <span className="font-semibold block truncate text-sm"><UserName pubkey={result.pubkey} /></span>
                  <span className="text-[11px] opacity-60 font-mono truncate block">{shortNpub(result.pubkey)}</span>
                </span>
                {result.existing && <span className="badge badge-ghost badge-xs">Existing</span>}
                {result.rank !== undefined && <span className="badge badge-outline badge-xs">{Math.round(result.rank * 100)}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
