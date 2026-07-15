// Mentions across a community's channels — the "@ Mentions" view.
//
// Uses the `#p` tag as a fast index-backed filter on each channel's RumorStore
// (the message factory adds `p` tags for `nostr:` mention tokens), then confirms
// with a content parse so a reply/reaction that merely p-tags the user (but
// doesn't mention them in text) doesn't surface. Unlike the per-channel unread
// scan, this reads every channel's full store via `#p` — so a mention buried
// deep under a busy channel's newest window still surfaces.
//
// Read state is independent of per-channel cursors: the Mentions view is one
// flat list tracking a single last-seen stamp per community.

import { useMemo } from "react";
import { auditTime, combineLatest, map } from "rxjs";
import { use$ } from "applesauce-react/hooks";
import { kinds } from "nostr-tools";
import type { ConcordCommunity } from "applesauce-concord";
import { parseImeta, rumorMs, type MediaAttachment } from "applesauce-concord/helpers";
import type { Rumor } from "applesauce-core/helpers";
import { mentions } from "./mentions";

export interface MentionRow {
  id: string;
  author: string;
  content: string;
  ms: number;
  channelId: string;
  attachments: MediaAttachment[];
  emojiTags: string[][];
  raw: Rumor;
}

const NO_MENTIONS: MentionRow[] = [];
const NO_ENTRIES: (readonly [string, Rumor[]])[] = [];

const SETTLE_MS = 250;

/**
 * Every message across the community's readable text channels that p-tags the
 * current user AND has a `nostr:` content mention of them. Newest-first.
 *
 * `channelIds` should be the community's text channel ids the user can read
 * (public channels + private channels whose key the user holds). Each is
 * queried with `#p:[pubkey]` so the in-memory store's tag index does the work.
 */
export function useMentions(
  community: ConcordCommunity | undefined,
  cid: string | undefined,
  channelIds: string[],
  pubkey: string,
): MentionRow[] {
  const idsKey = useMemo(() => [...channelIds].sort().join(","), [channelIds]);

  const rumors$ = useMemo(() => {
    if (!community || !cid || !pubkey || !idsKey) return undefined;
    const ids = idsKey.split(",");
    return combineLatest(
      ids.map((id) =>
        community
          .channelStore(id)
          .timeline([{ kinds: [kinds.ChatMessage], "#p": [pubkey] }])
          .pipe(map((rumors) => [id, rumors] as const)),
      ),
    ).pipe(auditTime(SETTLE_MS));
  }, [community, cid, pubkey, idsKey]);

  const entries = use$(rumors$) ?? NO_ENTRIES;

  return useMemo(() => {
    if (!pubkey || entries.length === 0) return NO_MENTIONS;
    const rows: MentionRow[] = [];
    for (const [channelId, rumors] of entries) {
      for (const r of rumors) {
        if (r.pubkey === pubkey) continue;
        if (!mentions(r.content, pubkey)) continue;
        rows.push({
          id: r.id,
          author: r.pubkey,
          content: r.content,
          ms: rumorMs(r),
          channelId,
          attachments: [...parseImeta(r.tags).values()],
          emojiTags: r.tags.filter((t) => t[0] === "emoji"),
          raw: r,
        });
      }
    }
    return rows.sort((a, b) => b.ms - a.ms);
  }, [entries, pubkey]);
}
