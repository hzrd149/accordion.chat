// Presentation-only adapter over SDK-resolved messages and visible reactions.

import { kinds, type NostrEvent } from "nostr-tools";
import type { Rumor } from "applesauce-core/helpers";
import type { ConcordChannelMessage } from "@applesauce/concord";
import { parseImeta, rumorMs, type MediaAttachment } from "@applesauce/concord/helpers";
import {
  getReactionEmoji,
  getCommentRootPointer,
  getCommentReplyPointer,
  type CommentPointer,
} from "applesauce-common/helpers";

const MESSAGE = kinds.ChatMessage; // 9
const REACTION = kinds.Reaction; // 7
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
  attachments: MediaAttachment[];
  emojiTags: string[][];
  raw: Rumor;
}

function eventPointer(pointer: CommentPointer | null): { id: string; author: string; kind: number } | null {
  if (!pointer || pointer.type !== "event") return null;
  return { id: pointer.id, author: pointer.pubkey ?? "", kind: pointer.kind };
}

export interface ChannelProjection {
  messages: ChatMessage[];
  threads: Map<string, ThreadComment[]>;
}

/** Concord owns edits, authorization, bans, deletes and expiry. This adapter only
 * groups visible rows for Accordion's thread/reaction UI and keeps originals for inspection. */
export function foldChannel(visible: readonly ConcordChannelMessage[], effects: readonly Rumor[], previous?: ChannelProjection): ChannelProjection {
  const messages = new Map<string, ChatMessage>();
  const threads = new Map<string, ThreadComment[]>();
  const previousMessages = new Map(previous?.messages.map((message) => [message.id, message]));
  const previousComments = new Map([...(previous?.threads.values() ?? [])].flat().map((comment) => [comment.id, comment]));
  const reactions = new Map<string, Map<string, { url?: string; authors: Set<string> }>>();
  const authorDeleted = new Set(effects.filter((effect) => effect.kind === 5).flatMap((deletion) =>
    deletion.tags.filter((tag) => tag[0] === "e").map((tag) => `${deletion.pubkey}:${tag[1]}`)));

  for (const { rumor: r, edit, content } of visible) {
    const old = previousMessages.get(r.id) ?? previousComments.get(r.id);
    const attachments = old?.raw === r ? old.attachments : [...parseImeta(r.tags).values()];
    const emojiTags = (edit ?? r).tags.filter((t) => t[0] === "emoji");
    const stableEmojiTags = old && sameItems(old.emojiTags, emojiTags) ? old.emojiTags : emojiTags;
    if (r.kind === MESSAGE) {
      const q = r.tags.find((t) => t[0] === "q");
      messages.set(r.id, {
        id: r.id, author: r.pubkey, content: r.content, ms: rumorMs(r),
        deleted: false, edited: edit ? content : undefined,
        replyTo: q ? { id: q[1], author: q[3] ?? "" } : undefined,
        threadReplyCount: 0, reactions: [], attachments,
        emojiTags: stableEmojiTags, raw: r,
      });
    } else if (r.kind === COMMENT) {
      const event = r as unknown as NostrEvent;
      const root = eventPointer(getCommentRootPointer(event));
      const parent = eventPointer(getCommentReplyPointer(event));
      if (!root || !parent || root.kind !== MESSAGE) continue;
      const comments = threads.get(root.id) ?? [];
      comments.push({ id: r.id, author: r.pubkey, content, ms: rumorMs(r),
        deleted: false, root, parent, attachments,
        emojiTags: stableEmojiTags, raw: r });
      threads.set(root.id, comments);
    }
  }
  for (const r of effects) {
    if (r.kind === REACTION && !authorDeleted.has(`${r.pubkey}:${r.id}`)) {
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
  for (const root of threads.keys()) if (!messages.has(root)) threads.delete(root);
  for (const msg of messages.values()) {
    msg.reactions = [...(reactions.get(msg.id) ?? [])].map(([emoji, { url, authors }]) => ({
      emoji, url, count: authors.size, authors: [...authors],
    }));
    msg.threadReplyCount = threads.get(msg.id)?.length ?? 0;
  }
  // Keep identity for unchanged rows, not just for the stream itself. Reaction
  // updates must not invalidate every sibling's memo or media-loading effect.
  for (const [id, message] of messages) {
    const old = previousMessages.get(id);
    if (old && old.raw === message.raw && old.edited === message.edited &&
      old.emojiTags === message.emojiTags && old.threadReplyCount === message.threadReplyCount &&
      old.reactions.length === message.reactions.length && old.reactions.every((reaction, index) => {
        const next = message.reactions[index];
        return reaction.emoji === next.emoji && reaction.url === next.url &&
          reaction.count === next.count && sameItems(reaction.authors, next.authors);
      })) messages.set(id, old);
  }
  for (const [rootId, comments] of threads) {
    comments.sort(compareRows);
    const stable = comments.map((comment) => {
      const old = previousComments.get(comment.id);
      return old && old.raw === comment.raw && old.content === comment.content &&
        old.emojiTags === comment.emojiTags ? old : comment;
    });
    const old = previous?.threads.get(rootId);
    threads.set(rootId, old && sameItems(old, stable) ? old : stable);
  }
  const rows = [...messages.values()].sort(compareRows);
  const stableMessages = previous && sameItems(previous.messages, rows) ? previous.messages : rows;
  const stableThreads = previous && previous.threads.size === threads.size &&
    [...threads].every(([id, comments]) => previous.threads.get(id) === comments) ? previous.threads : threads;
  return previous && stableMessages === previous.messages && stableThreads === previous.threads
    ? previous : { messages: stableMessages, threads: stableThreads };
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function compareRows(a: { ms: number; id: string }, b: { ms: number; id: string }): number {
  return a.ms - b.ms || a.id.localeCompare(b.id);
}
