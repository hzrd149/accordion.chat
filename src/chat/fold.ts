// App-owned chat and NIP-22 effects over retained, ban-filtered channel inputs.

import { kinds, type NostrEvent } from "nostr-tools";
import type { Rumor } from "applesauce-core/helpers";
import { EDIT_KIND, parseImeta, rumorMs, type MediaAttachment } from "@applesauce/concord/helpers";
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

export type CanDelete = (deleter: string, author: string) => boolean;
const authorDelete: CanDelete = (deleter, author) => deleter === author;

export interface ChannelProjection {
  messages: ChatMessage[];
  threads: Map<string, ThreadComment[]>;
}

/** One coherent view of messages and effects, rebuilt against current authority.
 * Inputs must come from channelTimeline so banned authors cannot contribute effects.
 * Deletions are requests, never irreversible tombstones: revoking authority restores history.
 */
export function foldChannel(rumors: Rumor[], canDelete: CanDelete = authorDelete): ChannelProjection {
  const byId = new Map(rumors.map((r) => [r.id, r]));
  const deleted = new Set<string>();
  for (const r of rumors) {
    if (r.kind !== DELETE) continue;
    for (const tag of r.tags) {
      if (tag[0] !== "e") continue;
      const target = byId.get(tag[1]);
      if (target && target.kind !== DELETE && canDelete(r.pubkey, target.pubkey)) deleted.add(target.id);
    }
  }
  const messages = new Map<string, ChatMessage>();
  const threads = new Map<string, ThreadComment[]>();
  const edits = new Map<string, Rumor>();
  const reactions = new Map<string, Map<string, { url?: string; authors: Set<string> }>>();

  for (const r of rumors) {
    if (r.kind === MESSAGE) {
      const q = r.tags.find((t) => t[0] === "q");
      messages.set(r.id, {
        id: r.id, author: r.pubkey, content: r.content, ms: rumorMs(r),
        deleted: deleted.has(r.id),
        replyTo: q ? { id: q[1], author: q[3] ?? "" } : undefined,
        threadReplyCount: 0, reactions: [], attachments: [...parseImeta(r.tags).values()],
        emojiTags: r.tags.filter((t) => t[0] === "emoji"), raw: r,
      });
    } else if (r.kind === COMMENT && !deleted.has(r.id)) {
      const event = r as unknown as NostrEvent;
      const root = eventPointer(getCommentRootPointer(event));
      const parent = eventPointer(getCommentReplyPointer(event));
      if (!root || !parent || root.kind !== MESSAGE || deleted.has(root.id)) continue;
      const comments = threads.get(root.id) ?? [];
      comments.push({ id: r.id, author: r.pubkey, content: r.content, ms: rumorMs(r),
        deleted: false, root, parent, emojiTags: r.tags.filter((t) => t[0] === "emoji"), raw: r });
      threads.set(root.id, comments);
    } else if (r.kind === EDIT_KIND && !deleted.has(r.id)) {
      const target = r.tags.find((t) => t[0] === "e")?.[1];
      if (!target || byId.get(target)?.pubkey !== r.pubkey) continue;
      const previous = edits.get(target);
      if (!previous || compareRumors(previous, r) < 0) edits.set(target, r);
    } else if (r.kind === REACTION && !deleted.has(r.id)) {
      const target = r.tags.find((t) => t[0] === "e")?.[1];
      if (!target) continue;
      const emojis = reactions.get(target) ?? new Map();
      const entry = emojis.get(r.content) ?? {
        url: getReactionEmoji(r as unknown as NostrEvent)?.url, authors: new Set<string>(),
      };
      entry.authors.add(r.pubkey);
      emojis.set(r.content, entry);
      reactions.set(target, emojis);
    }
  }
  for (const msg of messages.values()) {
    if (msg.deleted) continue;
    const edit = edits.get(msg.id);
    if (edit) {
      msg.edited = edit.content;
      msg.emojiTags = edit.tags.filter((t) => t[0] === "emoji");
    }
    msg.reactions = [...(reactions.get(msg.id) ?? [])].map(([emoji, { url, authors }]) => ({
      emoji, url, count: authors.size, authors: [...authors],
    }));
    msg.threadReplyCount = threads.get(msg.id)?.length ?? 0;
  }
  for (const comments of threads.values()) comments.sort(compareRows);
  return { messages: [...messages.values()].sort(compareRows), threads };
}

function compareRows(a: { ms: number; id: string }, b: { ms: number; id: string }): number {
  return a.ms - b.ms || a.id.localeCompare(b.id);
}
function compareRumors(a: Rumor, b: Rumor): number {
  return rumorMs(a) - rumorMs(b) || a.id.localeCompare(b.id);
}

/** Standalone fold for adapters/tests; live consumers share channelProjection. */
export function foldMessages(rumors: Rumor[], canDelete?: CanDelete): ChatMessage[] {
  return foldChannel(rumors, canDelete).messages;
}

export function foldThread(rumors: Rumor[], rootId: string, canDelete?: CanDelete): ThreadComment[] {
  return foldChannel(rumors, canDelete).threads.get(rootId) ?? [];
}
