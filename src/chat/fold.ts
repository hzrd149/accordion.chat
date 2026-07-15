// Chat/thread folds over a channel's RumorStore.
//
// applesauce-concord exposes each channel as a raw `RumorStore` (via
// `community.channelStore(id)`) and leaves chat rendering to the app. This is the
// app's fold: it turns the channel's decrypted rumors — messages (kind 9),
// reactions (7), edits (3302), deletions (5), and NIP-22 comments (1111) — into
// the flat `ChatMessage[]` / `ThreadComment[]` the UI renders, aggregating
// reactions, applying author-scoped edits/deletes, counting thread replies, and
// parsing NIP-92 encrypted attachments. Ported verbatim from the old monolithic
// client's `recomputeMessages`/`recomputeThread`, reading `Rumor` (not the
// package-internal `DecodedEvent`): `author = rumor.pubkey`, `ms = rumorMs(rumor)`.

import { kinds, type NostrEvent } from "nostr-tools";
import type { Rumor } from "applesauce-core/helpers";
import { EDIT_KIND, parseImeta, rumorMs, type MediaAttachment } from "applesauce-concord/helpers";
import {
  getReactionEmoji,
  getCommentRootPointer,
  getCommentReplyPointer,
  type CommentPointer,
} from "applesauce-common/helpers";

const MESSAGE = kinds.ChatMessage; // 9
const REACTION = kinds.Reaction; // 7
const DELETE = kinds.EventDeletion; // 5
const COMMENT = 1111; // NIP-22

export interface ChatMessage {
  id: string;
  author: string;
  content: string;
  ms: number;
  edited?: string;
  deleted: boolean;
  replyTo?: { id: string; author: string };
  threadReplyCount: number;
  /** `emoji` is the reaction content (a unicode char or `:shortcode:`); `url` is set for NIP-30 custom emoji. */
  reactions: { emoji: string; url?: string; count: number; authors: string[] }[];
  /** Encrypted media/files parsed from the message's NIP-92 imeta tags. */
  attachments: MediaAttachment[];
  /** The message's NIP-30 `["emoji", …]` tags, for rendering `:shortcode:` inline. */
  emojiTags: string[][];
  /** The decoded plane rumor, retained for the "view raw" debug view. */
  raw: Rumor;
}

export interface ThreadComment {
  id: string;
  author: string;
  content: string;
  ms: number;
  deleted: boolean;
  root: { id: string; author: string; kind: number };
  parent: { id: string; author: string; kind: number };
  emojiTags: string[][];
  raw: Rumor;
}

function eventPointer(pointer: CommentPointer | null): { id: string; author: string; kind: number } | null {
  if (!pointer || pointer.type !== "event") return null;
  return { id: pointer.id, author: pointer.pubkey ?? "", kind: pointer.kind };
}

/** Fold a channel's rumors into the ordered message list the UI renders. */
export function foldMessages(rumors: Rumor[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  // target -> reaction content -> { url?, authors }. A custom emoji reaction's
  // content is `:shortcode:` and carries the image URL from its own emoji tag.
  const reactions = new Map<string, Map<string, { url?: string; authors: Set<string> }>>();
  const threadCounts = new Map<string, number>();
  const edits: Rumor[] = [];
  const deletes: Rumor[] = [];

  const sorted = [...rumors].sort((a, b) => rumorMs(a) - rumorMs(b));
  for (const r of sorted) {
    if (r.kind === MESSAGE) {
      const q = r.tags.find((t) => t[0] === "q");
      byId.set(r.id, {
        id: r.id,
        author: r.pubkey,
        content: r.content,
        ms: rumorMs(r),
        deleted: false,
        replyTo: q ? { id: q[1], author: q[3] ?? "" } : undefined,
        threadReplyCount: 0,
        reactions: [],
        attachments: [...parseImeta(r.tags).values()],
        emojiTags: r.tags.filter((t) => t[0] === "emoji"),
        raw: r,
      });
    } else if (r.kind === COMMENT) {
      const root = eventPointer(getCommentRootPointer(r as unknown as NostrEvent));
      if (root?.kind === MESSAGE) threadCounts.set(root.id, (threadCounts.get(root.id) ?? 0) + 1);
    } else if (r.kind === EDIT_KIND) {
      edits.push(r);
    } else if (r.kind === DELETE) {
      deletes.push(r);
    } else if (r.kind === REACTION) {
      const target = r.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      let emap = reactions.get(target);
      if (!emap) {
        emap = new Map();
        reactions.set(target, emap);
      }
      let entry = emap.get(r.content);
      if (!entry) {
        // NIP-30: resolve a custom `:shortcode:` reaction to its image URL via
        // applesauce (plain unicode reactions resolve to undefined).
        const custom = getReactionEmoji(r as unknown as NostrEvent);
        entry = { url: custom?.url, authors: new Set() };
        emap.set(r.content, entry);
      }
      entry.authors.add(r.pubkey);
    }
  }

  // Apply edits/deletes only from the message's own author.
  for (const r of edits) {
    const targetId = r.tags.find((t) => t[0] === "e")?.[1];
    const msg = targetId ? byId.get(targetId) : undefined;
    if (msg && msg.author === r.pubkey) {
      msg.edited = r.content;
      // Replace emoji tags with the edit's so :shortcode: renders against the
      // edit's NIP-30 tags, not the original message's (which may differ).
      const editEmojiTags = r.tags.filter((t) => t[0] === "emoji");
      if (editEmojiTags.length) msg.emojiTags = editEmojiTags;
    }
  }
  for (const r of deletes) {
    for (const t of r.tags) {
      if (t[0] !== "e") continue;
      const msg = byId.get(t[1]);
      if (msg && msg.author === r.pubkey) msg.deleted = true;
    }
  }
  for (const [target, emap] of reactions) {
    const msg = byId.get(target);
    if (!msg) continue;
    msg.reactions = [...emap.entries()].map(([emoji, { url, authors }]) => ({
      emoji,
      url,
      count: authors.size,
      authors: [...authors],
    }));
  }
  for (const [target, count] of threadCounts) {
    const msg = byId.get(target);
    if (msg) msg.threadReplyCount = count;
  }

  return [...byId.values()].sort((a, b) => a.ms - b.ms);
}

/** Fold a channel's NIP-22 comments into the thread rooted at `rootId`. */
export function foldThread(rumors: Rumor[], rootId: string): ThreadComment[] {
  const comments: ThreadComment[] = [];
  const sorted = [...rumors].sort((a, b) => rumorMs(a) - rumorMs(b));
  for (const r of sorted) {
    if (r.kind !== COMMENT) continue;
    const event = r as unknown as NostrEvent;
    const root = eventPointer(getCommentRootPointer(event));
    const parent = eventPointer(getCommentReplyPointer(event));
    if (!root || !parent || root.id !== rootId || root.kind !== MESSAGE) continue;
    comments.push({
      id: r.id,
      author: r.pubkey,
      content: r.content,
      ms: rumorMs(r),
      deleted: false,
      root,
      parent,
      emojiTags: r.tags.filter((t) => t[0] === "emoji"),
      raw: r,
    });
  }
  return comments;
}
