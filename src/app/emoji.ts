// NIP-30 custom emoji support for the UI: reads the active user's favorite
// emoji list (NIP-51 kind 10030) — both the inline emoji and any referenced
// kind-30030 packs — reactively out of the single EventStore, upgrading in
// place as the events resolve from relays (via the loader wired in nostr.ts).

import { useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import { combineLatest, map, of, switchMap } from "rxjs";
import {
  getEmojiPackEmojis,
  getFavoriteEmojiPackPointers,
  getFavoriteEmojis,
  type Emoji,
} from "applesauce-common/helpers";
import { eventStore } from "../nostr";

export type { Emoji };

const FAVORITE_EMOJI_LIST_KIND = 10030;

/** Default unicode reactions offered when the user has no custom favorites. */
export const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉", "😮", "😢", "🙏"];

/** Dedupe emojis by shortcode, keeping the first-seen URL. */
function dedupe(emojis: Emoji[]): Emoji[] {
  const seen = new Set<string>();
  return emojis.filter((e) => (seen.has(e.shortcode) ? false : (seen.add(e.shortcode), true)));
}

/**
 * The user's NIP-30 favorite custom emojis (kind 10030 + referenced 30030
 * packs). Returns `[]` until the list resolves, or when `pubkey` is undefined.
 */
export function useFavoriteEmojis(pubkey: string | undefined): Emoji[] {
  const emojis$ = useMemo(() => {
    if (!pubkey) return of<Emoji[]>([]);
    return eventStore.replaceable(FAVORITE_EMOJI_LIST_KIND, pubkey).pipe(
      switchMap((list) => {
        if (!list) return of<Emoji[]>([]);
        const inline = getFavoriteEmojis(list);
        const pointers = getFavoriteEmojiPackPointers(list);
        if (!pointers.length) return of(inline);
        return combineLatest(pointers.map((p) => eventStore.addressable(p))).pipe(
          map((packs) => [...inline, ...packs.filter((e): e is NonNullable<typeof e> => !!e).flatMap(getEmojiPackEmojis)]),
        );
      }),
      map(dedupe),
    );
  }, [pubkey]);
  return use$(emojis$) ?? [];
}
