import { useEffect, useState } from "react";

export const DEFAULT_OPEN_RANKING_PROVIDER = "https://staging.brainstorm.world";

export const OPEN_RANKING_PRESETS: { url: string; label: string; hint: string }[] = [
  { url: "https://staging.brainstorm.world", label: "Brainstorm", hint: "staging.brainstorm.world — default" },
  { url: "https://ranking.vertexlab.io", label: "Vertex Lab", hint: "ranking.vertexlab.io" },
];

const KEY = "accordion:open-ranking-provider";
const CHANGE_EVENT = "accordion:open-ranking-provider-change";

export interface OpenRankingAlgorithm {
  id: string;
  name?: string;
  description?: string;
  pov?: boolean;
}

export type OpenRankingCapabilities = Record<string, OpenRankingAlgorithm[]>;

export interface OpenRankingPubkeyResult {
  pubkey: string;
  rank: number;
}

export interface OpenRankingSearchResponse {
  results: OpenRankingPubkeyResult[];
  ttl?: number;
}

function normalizeProvider(input: string): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function getOpenRankingProvider(): string {
  try {
    const stored = localStorage.getItem(KEY);
    return (stored && normalizeProvider(stored)) || DEFAULT_OPEN_RANKING_PROVIDER;
  } catch {
    return DEFAULT_OPEN_RANKING_PROVIDER;
  }
}

export function setOpenRankingProvider(provider: string): string {
  const normalized = normalizeProvider(provider);
  if (!normalized) throw new Error("Enter a valid HTTP(S) provider URL");
  try {
    if (normalized === DEFAULT_OPEN_RANKING_PROVIDER) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, normalized);
  } catch {
    /* localStorage may be unavailable; still update mounted hooks. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
  return normalized;
}

export function resetOpenRankingProvider() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore persistence failures */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useOpenRankingProvider(): {
  provider: string;
  setProvider: (provider: string) => string;
  resetProvider: () => void;
} {
  const [provider, setProviderState] = useState(getOpenRankingProvider);

  useEffect(() => {
    const onChange = () => setProviderState(getOpenRankingProvider());
    window.addEventListener(CHANGE_EVENT, onChange);
    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  return {
    provider,
    setProvider: setOpenRankingProvider,
    resetProvider: resetOpenRankingProvider,
  };
}

export async function fetchOpenRankingCapabilities(provider = getOpenRankingProvider()): Promise<OpenRankingCapabilities> {
  const normalized = normalizeProvider(provider);
  if (!normalized) throw new Error("Invalid Open Ranking provider URL");
  const res = await fetch(`${normalized}/.well-known/open-ranking.json`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Provider returned ${res.status}`);
  return (await res.json()) as OpenRankingCapabilities;
}

export async function searchOpenRankingPubkeys(
  query: string,
  opts: { provider?: string; limit?: number; pov?: string } = {},
): Promise<OpenRankingSearchResponse> {
  const q = query.trim().slice(0, 512);
  if (!q) return { results: [] };

  const provider = normalizeProvider(opts.provider ?? getOpenRankingProvider());
  if (!provider) throw new Error("Invalid Open Ranking provider URL");

  const body: Record<string, unknown> = { query: q, limit: opts.limit ?? 12 };
  if (opts.pov) body.pov = opts.pov;

  const res = await fetch(`${provider}/search/pubkeys`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });

  if (res.status === 202) {
    const retry = res.headers.get("retry-after");
    throw new Error(retry ? `Search is still indexing. Try again in ${retry}s.` : "Search is still indexing. Try again soon.");
  }
  if (!res.ok) throw new Error(`Search failed with ${res.status}`);
  return (await res.json()) as OpenRankingSearchResponse;
}
