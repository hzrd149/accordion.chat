import { nip19 } from "nostr-tools";
import type { UserSearchResult } from "./types";

export const EXPIRATIONS = [
  { label: "None", value: "none", seconds: null },
  { label: "30m", value: "30m", seconds: 60 * 30 },
  { label: "1d", value: "1d", seconds: 60 * 60 * 24 },
  { label: "1w", value: "1w", seconds: 60 * 60 * 24 * 7 },
  { label: "2w", value: "2w", seconds: 60 * 60 * 24 * 14 },
  { label: "1y", value: "1y", seconds: 60 * 60 * 24 * 365 },
] as const;

export type ExpirationValue = (typeof EXPIRATIONS)[number]["value"];

export const DEFAULT_EXPIRATION: ExpirationValue = "2w";
export function expirationKey(self: string, peer: string) {
  return `accordion:dm-expiration:${self}:${peer}`;
}

export function isHexPubkey(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value);
}

export function normalizePubkey(value: string): string | null {
  const trimmed = value.trim();
  if (isHexPubkey(trimmed)) return trimmed.toLowerCase();
  try {
    const decoded = nip19.decode(trimmed);
    if (decoded.type === "npub" && typeof decoded.data === "string") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    return null;
  }
  return null;
}

export function dedupeSearchResults(results: UserSearchResult[]): UserSearchResult[] {
  const seen = new Set<string>();
  const out: UserSearchResult[] = [];
  for (const result of results) {
    if (seen.has(result.pubkey)) continue;
    seen.add(result.pubkey);
    out.push(result);
  }
  return out;
}

export function readStoredExpiration(self: string, peer: string): ExpirationValue | null {
  try {
    const value = localStorage.getItem(expirationKey(self, peer));
    return EXPIRATIONS.some((e) => e.value === value) ? (value as ExpirationValue) : null;
  } catch {
    return null;
  }
}

export function writeStoredExpiration(self: string, peer: string, value: ExpirationValue) {
  try {
    localStorage.setItem(expirationKey(self, peer), value);
  } catch {
    // Ignore unavailable localStorage.
  }
}
