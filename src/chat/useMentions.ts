// Mentions across a community's channels — the "@ Mentions" view.
//
// Uses the same edited, ban- and deletion-aware view as chat and unread counts.
// A p-tag-only filter would lose delete requests and newly added edit mentions.
//
// Read state is independent of per-channel cursors: the Mentions view is one
// flat list tracking a single last-seen stamp per community.

import { useMemo } from "react";
import { auditTime, combineLatest, map } from "rxjs";
import { use$ } from "applesauce-react/hooks";
import type { ConcordCommunity } from "@applesauce/concord";
import type { MediaAttachment } from "@applesauce/concord/helpers";
import type { Rumor } from "applesauce-core/helpers";
import { mentions } from "./mentions";
import { channelProjection } from "./projection";
import type { ChatMessage } from "./fold";

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
const NO_ENTRIES: (readonly [string, ChatMessage[]])[] = [];

const SETTLE_MS = 250;

/**
 * Every visible message mentioning the current user in its current content. Newest-first.
 *
 * `channelIds` should be the community's text channel ids the user can read
 * (public channels + private channels whose key the user holds). Each is
 * projected with all effects so edits and deletes stay consistent with chat.
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
        channelProjection(community, id).pipe(map((view) => [id, view.messages] as const)),
      ),
    ).pipe(auditTime(SETTLE_MS));
  }, [community, cid, pubkey, idsKey]);

  const entries = use$(rumors$) ?? NO_ENTRIES;

  return useMemo(() => collectMentions(entries, pubkey), [entries, pubkey]);
}

/** Apply current edited content and visibility, without relying on original p tags. */
export function collectMentions(entries: (readonly [string, ChatMessage[]])[], pubkey: string): MentionRow[] {
  if (!pubkey || entries.length === 0) return NO_MENTIONS;
  const rows: MentionRow[] = [];
  for (const [channelId, rumors] of entries) {
    for (const r of rumors) {
      if (r.deleted || r.author === pubkey) continue;
      if (!mentions(r.edited ?? r.content, pubkey)) continue;
      rows.push({
        id: r.id,
        author: r.author,
        content: r.edited ?? r.content,
        ms: r.ms,
        channelId,
        attachments: r.attachments,
        emojiTags: r.emojiTags,
        raw: r.raw,
      });
    }
  }
  return rows.sort((a, b) => b.ms - a.ms);
}
