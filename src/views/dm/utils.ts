import { getConversationParticipants, getRumorGiftWraps, type Rumor } from "applesauce-common/helpers";
import { getExpirationTimestamp } from "applesauce-core/helpers";
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
export const SYNC_LOOKBACK_SECONDS = 60 * 60 * 24 * 14;

export const NO_MESSAGES: Rumor[] = [];
export const NO_RELAYS: string[] = [];

export function failedKey(pubkey: string) {
  return `accordion:dm-failed-wraps:${pubkey}`;
}

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

export function oneToOnePeer(self: string, message: Rumor): string | null {
  const participants = [...new Set(getConversationParticipants(message))];
  if (participants.length !== 2 || !participants.includes(self)) return null;
  const peer = participants.find((p) => p !== self);
  return peer && isHexPubkey(peer) ? peer : null;
}

export function readFailed(pubkey: string): string[] {
  try {
    const raw = localStorage.getItem(failedKey(pubkey));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function writeFailed(pubkey: string, ids: string[]) {
  try {
    localStorage.setItem(failedKey(pubkey), JSON.stringify(ids));
  } catch {
    // Ignore unavailable localStorage.
  }
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

export function inferExpiration(messages: Rumor[]): ExpirationValue {
  const newest = [...messages]
    .sort((a, b) => b.created_at - a.created_at)
    .find((message) => getRumorGiftWraps(message).some((wrap) => typeof getExpirationTimestamp(wrap) === "number"));
  if (!newest) return DEFAULT_EXPIRATION;

  const expires = getRumorGiftWraps(newest)
    .map(getExpirationTimestamp)
    .find((value): value is number => typeof value === "number");
  if (!expires) return DEFAULT_EXPIRATION;

  const duration = Math.max(0, expires - newest.created_at);
  const choices = EXPIRATIONS.filter((e) => e.seconds !== null);
  return choices.reduce((best, current) =>
    Math.abs((current.seconds ?? 0) - duration) < Math.abs((best.seconds ?? 0) - duration) ? current : best,
  ).value;
}
