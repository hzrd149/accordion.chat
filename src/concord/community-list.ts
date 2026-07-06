// CORD-02 §8 Community List (kind 13302) — liveness semantics.
//
// A member's memberships sync across devices/clients as one self-encrypted
// replaceable event. Nothing is ever deleted: every community joined AND every
// one left stays in the document, and liveness is DERIVED — a re-join
// legitimately resurrects a tombstoned id, while a stale device can never
// re-add one it never re-joined. This mirrors armada `concord-v2/lib/
// communityList.ts` (`isLive`) so both clients agree on which memberships show.

import type { JoinMaterial } from "./types";

export interface CommunityListEntry {
  community_id: string;
  /** Earliest epoch held — the backfill anchor (only ever moves backward on merge). */
  seed: JoinMaterial;
  /** Freshest snapshot — replaced on every Refounding or rename. */
  current: JoinMaterial;
  /** ms; tiebreaks against a tombstone's removed_at. */
  added_at: number;
  [k: string]: unknown;
}

export interface CommunityTombstone {
  community_id: string;
  /** ms. Permanent — pruning would let a long-offline device resurrect a leave. */
  removed_at: number;
  [k: string]: unknown;
}

export interface CommunityList {
  entries: CommunityListEntry[];
  tombstones: CommunityTombstone[];
  [k: string]: unknown;
}

/** The newest `added_at` for a community across (possibly un-merged) entries, or undefined if absent. */
function newestAdd(list: CommunityList, communityId: string): number | undefined {
  let added: number | undefined;
  for (const e of list.entries ?? []) {
    if (e?.community_id !== communityId) continue;
    const at = typeof e.added_at === "number" ? e.added_at : 0;
    added = added === undefined ? at : Math.max(added, at);
  }
  return added;
}

/** The newest removal; a tombstone lacking a valid `removed_at` is treated as terminal (+∞). */
function newestRemoval(list: CommunityList, communityId: string): number | undefined {
  let removed: number | undefined;
  for (const t of list.tombstones ?? []) {
    if (t?.community_id !== communityId) continue;
    const at = typeof t.removed_at === "number" ? t.removed_at : Infinity;
    removed = removed === undefined ? at : Math.max(removed, at);
  }
  return removed;
}

/**
 * Whether a membership is live: it has an entry, and either no tombstone or its
 * newest add postdates the newest removal (CORD-02 §8). A re-join resurrects; a
 * pure leave stays dead.
 */
export function isCommunityLive(list: CommunityList, communityId: string): boolean {
  const added = newestAdd(list, communityId);
  if (added === undefined) return false;
  const removed = newestRemoval(list, communityId);
  return removed === undefined || added > removed;
}

/** The live memberships, derived (deduped by community_id, newest-add snapshot). */
export function liveCommunityEntries(list: CommunityList): CommunityListEntry[] {
  const live = new Map<string, CommunityListEntry>();
  for (const e of list.entries ?? []) {
    if (!e?.community_id || !isCommunityLive(list, e.community_id)) continue;
    const prev = live.get(e.community_id);
    if (!prev || (e.added_at ?? 0) >= (prev.added_at ?? 0)) live.set(e.community_id, e);
  }
  return [...live.values()];
}
