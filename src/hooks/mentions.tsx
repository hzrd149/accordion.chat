// @-mention support for the composer: a reactive index of a community's members
// keyed by display name, searched with fuse.js. Selecting a candidate inserts a
// `nostr:npub…` link into the draft — the chat rumor builder (`messageRumor`)
// turns that into the NIP-C7 `p` tag automatically.

import { useCallback, useMemo } from "react";
import { combineLatest, of } from "rxjs";
import { map, startWith } from "rxjs/operators";
import { use$ } from "applesauce-react/hooks";
import { castUser, Profile } from "applesauce-common/casts";
import { castEventStream } from "applesauce-common/observable";
import Fuse from "fuse.js";
import { nip19 } from "nostr-tools";
import { eventStore } from "../nostr";
import { shortNpub } from "../lib/util";

export interface MentionCandidate {
  pubkey: string;
  npub: string;
  /** Display name once the kind-0 profile loads, else a short npub. */
  name: string;
  picture?: string;
}

const MAX_RESULTS = 8;

/**
 * Reactively resolve each member pubkey's kind-0 profile into a mention
 * candidate. Each entry emits a short-npub fallback immediately and upgrades in
 * place the moment its profile loads (same cast/loader path as `User.tsx`), so
 * the menu is usable before every profile has arrived.
 */
export function useMentionCandidates(members: string[]): MentionCandidate[] {
  const key = members.join(",");
  const stream$ = useMemo(() => {
    if (members.length === 0) return of<MentionCandidate[]>([]);
    return combineLatest(
      members.map((pubkey) => {
        const npub = nip19.npubEncode(pubkey);
        const fallback: MentionCandidate = { pubkey, npub, name: shortNpub(pubkey) };
        return castUser(pubkey, eventStore)
          .replaceable(0)
          .pipe(
            castEventStream(Profile, eventStore),
            map((p): MentionCandidate =>
              p ? { pubkey, npub, name: p.displayName || shortNpub(pubkey), picture: p.picture } : fallback,
            ),
            startWith(fallback),
          );
      }),
    );
    // key is the stable dependency; members is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (use$(stream$) as MentionCandidate[] | undefined) ?? [];
}

/**
 * Build a fuzzy search over the candidates. Returns a `search(query)` that, on an
 * empty query, lists the first candidates so `@` alone opens a browsable menu.
 */
export function useMentionSearch(candidates: MentionCandidate[]): (query: string) => MentionCandidate[] {
  const fuse = useMemo(
    () => new Fuse(candidates, { keys: ["name", "npub"], threshold: 0.4, ignoreLocation: true }),
    [candidates],
  );
  return useCallback(
    (query: string): MentionCandidate[] => {
      const q = query.trim();
      if (!q) return candidates.slice(0, MAX_RESULTS);
      return fuse.search(q, { limit: MAX_RESULTS }).map((r) => r.item);
    },
    [fuse, candidates],
  );
}

/**
 * If the caret sits inside an `@token` (a `@` at word start with no whitespace up
 * to the caret), return the query text after the `@` and the `@`'s index. The
 * token ends at the first whitespace, so a completed word closes the menu.
 */
export function detectMention(value: string, caret: number): { query: string; start: number } | null {
  const upto = value.slice(0, caret);
  const m = /(?:^|\s)@(\S*)$/.exec(upto);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}
