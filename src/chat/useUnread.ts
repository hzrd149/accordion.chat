// Per-channel unread counts for the sidebar badges.
//
// This works without any extra subscriptions because ConcordCommunity runs ONE
// live subscription (kind 1059 by author) covering every plane and routes each
// decoded rumor into its per-channel store — creating that store on demand. So a
// channel you have never opened still accumulates rumors, and they hydrate from
// the IndexedDB rumor cache on reload. We just count what is already there.
//
// Note this reads the stores directly rather than reusing `useMessages`: that
// hook runs the full `foldMessages` (reactions, edits, deletes, thread counts,
// imeta parsing) for one channel, which is far more work than a count needs, and
// it only covers the mounted channel anyway.

import { useEffect, useMemo, useState } from "react";
import { auditTime, combineLatest, map } from "rxjs";
import { use$ } from "applesauce-react/hooks";
import { kinds } from "nostr-tools";
import type { ConcordCommunity } from "applesauce-concord";
import { rumorMs } from "applesauce-concord/helpers";
import type { Rumor } from "applesauce-core/helpers";
import { ensureBaseline, getLastRead, getReadState, markRead, useReadState } from "../lib/read-state";
import type { ChatMessage } from "./fold";
import { mentions } from "./mentions";

/** Unread summary for one channel. */
export interface ChannelUnread {
  /** Unread messages from other authors. */
  count: number;
  /** Whether any unread message mentions the current user. */
  mention: boolean;
}

export type UnreadMap = Record<string, ChannelUnread>;

const EMPTY: UnreadMap = {};
const NO_ENTRIES: (readonly [string, Rumor[]])[] = [];

// Coalesce store churn: a burst of arriving rumors (or a cache hydrate, which
// adds every cached rumor one by one) would otherwise re-count on every add.
const SETTLE_MS = 250;

function summarize(rumors: Rumor[], lastRead: number, pubkey: string): ChannelUnread {
  let count = 0;
  let mention = false;
  for (const r of rumors) {
    // Never unread from yourself.
    if (r.pubkey === pubkey) continue;
    if (rumorMs(r) <= lastRead) continue;
    count++;
    if (!mention) mention = mentions(r.content, pubkey);
  }
  return { count, mention };
}

/**
 * Unread counts for every channel in a community, keyed by channel id.
 *
 * `channelIds` should already exclude deleted channels. Voice channels carry no
 * chat, so they simply count zero rather than being special-cased.
 */
export function useUnreadCounts(
  community: ConcordCommunity | undefined,
  cid: string | undefined,
  channelIds: string[],
  pubkey: string,
): UnreadMap {
  const readState = useReadState(pubkey);

  // Stamp the baseline before counting: without it every channel in a
  // just-joined community would fall back to a 0 cursor and report its entire
  // history as unread.
  useEffect(() => {
    if (cid && pubkey) ensureBaseline(pubkey, cid);
  }, [cid, pubkey]);

  // Depend on the joined ids, not the array identity — `state.channels` is
  // rebuilt on every control-plane fold, which would otherwise resubscribe
  // every channel's timeline on each emission.
  const idsKey = useMemo(() => [...channelIds].sort().join(","), [channelIds]);

  const rumors$ = useMemo(() => {
    if (!community || !cid || !idsKey) return undefined;
    const ids = idsKey.split(",");
    return combineLatest(
      ids.map((id) =>
        community
          .channelStore(id)
          .timeline([{ kinds: [kinds.ChatMessage] }])
          .pipe(map((rumors) => [id, rumors] as const)),
      ),
    ).pipe(auditTime(SETTLE_MS));
  }, [community, cid, idsKey]);

  const entries = use$(rumors$) ?? NO_ENTRIES;

  // Counting is separate from the subscription so a read-state change (marking a
  // channel read) recomputes without resubscribing every store.
  return useMemo(() => {
    if (!cid || !pubkey || entries.length === 0) return EMPTY;
    const out: UnreadMap = {};
    for (const [id, rumors] of entries) {
      out[id] = summarize(rumors, getLastRead(readState, cid, id), pubkey);
    }
    return out;
  }, [entries, readState, cid, pubkey]);
}

/** Whether the window currently has focus. */
function useWindowFocused(): boolean {
  const [focused, setFocused] = useState(() => document.hasFocus());
  useEffect(() => {
    const onChange = () => setFocused(document.hasFocus());
    window.addEventListener("focus", onChange);
    window.addEventListener("blur", onChange);
    return () => {
      window.removeEventListener("focus", onChange);
      window.removeEventListener("blur", onChange);
    };
  }, []);
  return focused;
}

/**
 * Advance the open channel's cursor to its newest message while the user is
 * actually looking at it: the channel is mounted, the window has focus, and the
 * newest message is on screen. A backgrounded tab keeps accumulating unread
 * rather than silently swallowing it, and messages arriving while you are
 * scrolled up into history stay unread until you come back down to them.
 *
 * `markRead` is a no-op when the cursor is already at or past `newestMs`, so the
 * common re-render costs a compare and writes nothing.
 */
export function useMarkRead(
  pubkey: string,
  cid: string | undefined,
  channelId: string,
  newestMs: number,
  atBottom: boolean,
) {
  const focused = useWindowFocused();
  useEffect(() => {
    if (!pubkey || !cid || !newestMs || !focused || !atBottom) return;
    markRead(pubkey, cid, channelId, newestMs);
  }, [pubkey, cid, channelId, newestMs, focused, atBottom]);
}

/**
 * The id of the message to draw the "new messages" divider above, or undefined.
 *
 * Two values are frozen when you enter a channel, and both matter:
 *
 * `lastRead` is captured during render, before `useMarkRead`'s effect can
 * advance it — reading it reactively would erase the divider the instant the
 * channel is marked read, which is the whole thing we are trying to draw.
 *
 * `openedAt` bounds the divider to messages that were *already* unread when you
 * arrived. Without it, a message arriving while you sit in the channel is newer
 * than the frozen cursor and would spawn a fresh "new messages" line above
 * itself every time someone speaks. Bounding on arrival time also means the
 * divider converges correctly as history hydrates async (IndexedDB first, then
 * relays) rather than being settled from whatever the first emission happened to
 * contain.
 */
export function useNewMessagesDivider(
  pubkey: string,
  cid: string | undefined,
  channelId: string,
  messages: ChatMessage[],
): string | undefined {
  const key = `${pubkey}:${cid ?? ""}:${channelId}`;

  // Captured during render via the render-phase reset the codebase uses
  // elsewhere (the documented alternative to a setState-in-effect) — it has to
  // land before this component's effects run, since useMarkRead's effect is one
  // of them. Keyed on the channel, so a re-render never re-reads the cursor;
  // only actually entering a different channel does.
  const [frozen, setFrozen] = useState(() => snapshot(key, pubkey, cid, channelId));
  if (frozen.key !== key) setFrozen(snapshot(key, pubkey, cid, channelId));

  const { lastRead, openedAt } = frozen;
  return useMemo(() => {
    // A never-read channel has no divider: flagging the entire history of a
    // channel you just opened for the first time is noise, not signal.
    if (!lastRead) return undefined;
    return messages.find((m) => m.ms > lastRead && m.ms < openedAt && m.author !== pubkey)?.id;
  }, [messages, lastRead, openedAt, pubkey]);
}

/**
 * The pair of values frozen for the duration of a channel visit. Both are read
 * once, at entry: the caller's key guard is what keeps them stable, so a
 * re-render can neither re-read the cursor nor advance `openedAt`.
 */
const snapshot = (key: string, pubkey: string, cid: string | undefined, channelId: string) => ({
  key,
  lastRead: cid ? getLastRead(getReadState(pubkey), cid, channelId) : 0,
  openedAt: Date.now(),
});

/** Aggregate a community's per-channel unread into one rail-level summary. */
export function rollup(unread: UnreadMap): ChannelUnread {
  let count = 0;
  let mention = false;
  for (const u of Object.values(unread)) {
    count += u.count;
    mention ||= u.mention;
  }
  return { count, mention };
}
