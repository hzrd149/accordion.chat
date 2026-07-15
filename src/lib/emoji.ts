// NIP-30 custom emoji support for the UI: reads the active user's favorite
// emoji list (NIP-51 kind 10030) — both the inline emoji and any referenced
// kind-30030 packs, public AND hidden (NIP-44-encrypted) — reactively out of
// the single EventStore, upgrading in place as the events resolve from relays
// and as the hidden content is unlocked (via the signer).

import { useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import { combineLatest, map, of, switchMap, tap } from "rxjs";
import { watchEventUpdates } from "applesauce-core/observable";
import { hasHiddenTags } from "applesauce-core/helpers";
import {
  getEmojiPackEmojis,
  getFavoriteEmojiPackPointers,
  getFavoriteEmojis,
  getHiddenFavoriteEmojiPackPointers,
  getHiddenFavoriteEmojis,
  isHiddenFavoriteEmojiPacksUnlocked,
  unlockHiddenFavoriteEmojiPacks,
  type Emoji,
} from "applesauce-common/helpers";
import { eventStore } from "../nostr";
import type { HiddenContentSigner } from "applesauce-core/helpers";

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
 * packs). Reads both public and hidden (NIP-44-encrypted) favorites, unlocking
 * the hidden content with `signer` when available. Returns `[]` until the list
 * resolves, or when `pubkey` is undefined.
 *
 * The `watchEventUpdates` operator keeps the stream live across the unlock:
 * `unlockHiddenFavoriteEmojiPacks` mutates the event in place and calls
 * `notifyEventUpdate`, which fires `eventStore.update$` — `watchEventUpdates`
 * picks that up and re-emits, so the `switchMap` re-reads the now-unlocked
 * hidden emojis without a second subscription.
 */
export function useFavoriteEmojis(pubkey: string | undefined, signer?: HiddenContentSigner): Emoji[] {
  const emojis$ = useMemo(() => {
    if (!pubkey) return of<Emoji[]>([]);
    return eventStore.replaceable(FAVORITE_EMOJI_LIST_KIND, pubkey).pipe(
      switchMap((list) => {
        if (!list) return of<Emoji[]>([]);

        // `watchEventUpdates` re-emits the list when `notifyEventUpdate` fires
        // (after unlock), so the switchMap below re-reads hidden emojis.
        return of(list).pipe(
          watchEventUpdates(eventStore),
          tap((event) => {
            if (event && signer && hasHiddenTags(event) && !isHiddenFavoriteEmojiPacksUnlocked(event)) {
              void unlockHiddenFavoriteEmojiPacks(event, signer).catch(() => {});
            }
          }),
          switchMap((event) => {
            if (!event) return of<Emoji[]>([]);

            const inline = [
              ...getFavoriteEmojis(event),
              ...(getHiddenFavoriteEmojis(event) ?? []),
            ];

            const pointers = [
              ...getFavoriteEmojiPackPointers(event),
              ...(getHiddenFavoriteEmojiPackPointers(event) ?? []),
            ];

            if (!pointers.length) return of(dedupe(inline));

            return combineLatest(pointers.map((p) => eventStore.addressable(p))).pipe(
              map((packs) =>
                dedupe([
                  ...inline,
                  ...packs.filter((e): e is NonNullable<typeof e> => !!e).flatMap(getEmojiPackEmojis),
                ]),
              ),
            );
          }),
        );
      }),
    );
  }, [pubkey, signer]);
  return use$(emojis$) ?? [];
}
