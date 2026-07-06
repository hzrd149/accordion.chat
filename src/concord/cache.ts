// Local decrypt-and-cache of decoded plane rumors (per community).
//
// We never cache raw kind-1059 wraps — only the decoded rumor + verified author
// (the data we already hold the keys for). This makes the control plane and its
// channels, plus membership, survive a reload instantly and independently of
// whether a relay re-serves the giftwraps (some require NIP-42 AUTH, some are
// slow, some drop them). The relay subscription then syncs anything newer.

import type { DecodedEvent } from "./types";

export type Plane = "control" | "guestbook" | "channel";

export interface CachedEntry {
  plane: Plane;
  channelId?: string;
  decoded: DecodedEvent;
}

const KEY = (cid: string) => `concord:cache:${cid}`;
/** Cap cached chat per channel; control/guestbook are small and kept whole. */
export const MAX_CHANNEL_CACHE = 300;

export function loadCache(cid: string): CachedEntry[] {
  try {
    const raw = localStorage.getItem(KEY(cid));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { events?: CachedEntry[] };
    return Array.isArray(parsed.events) ? parsed.events : [];
  } catch {
    return [];
  }
}

export function saveCache(cid: string, entries: CachedEntry[]): void {
  try {
    localStorage.setItem(KEY(cid), JSON.stringify({ v: 1, events: entries }));
  } catch (err) {
    console.warn("concord cache write failed", err);
  }
}

export function clearCache(cid: string): void {
  try {
    localStorage.removeItem(KEY(cid));
  } catch {
    /* ignore */
  }
}
