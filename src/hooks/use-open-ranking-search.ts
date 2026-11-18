import { useEffect, useState } from "react";
import { parsePubkey } from "../helpers/user-search";
import { searchOpenRankingPubkeys, type OpenRankingPubkeyResult } from "../services/open-ranking";

const NO_RESULTS: OpenRankingPubkeyResult[] = [];

/**
 * Debounced network user search through the configured Open Ranking provider —
 * the fallback for finding people outside a community (direct invites, new DMs).
 * Skipped when disabled, for empty queries, and for pasted pubkeys/npubs.
 */
export function useOpenRankingSearch(
  query: string,
  { enabled = true, limit = 12, delay = 300 }: { enabled?: boolean; limit?: number; delay?: number } = {},
): { results: OpenRankingPubkeyResult[]; searching: boolean; error: string } {
  const [state, setState] = useState<{ query: string; results: OpenRankingPubkeyResult[]; error: string }>({
    query: "",
    results: NO_RESULTS,
    error: "",
  });
  const [inFlight, setInFlight] = useState<string | null>(null);
  const q = query.trim();
  const active = enabled && Boolean(q) && !parsePubkey(q);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setInFlight(q);
      searchOpenRankingPubkeys(q, { limit })
        .then((res) => {
          if (!cancelled) setState({ query: q, results: res.results, error: "" });
        })
        .catch((e) => {
          if (!cancelled) {
            setState({ query: q, results: NO_RESULTS, error: e instanceof Error ? e.message : "Global search failed" });
          }
        })
        .finally(() => {
          if (!cancelled) setInFlight((current) => (current === q ? null : current));
        });
    }, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [active, q, limit, delay]);

  if (!active) return { results: NO_RESULTS, searching: false, error: "" };
  // Results from an older query stay visible until the new one lands.
  return { results: state.results, searching: inFlight === q, error: state.query === q ? state.error : "" };
}
