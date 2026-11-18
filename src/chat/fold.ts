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
  const previousMessages = new Map<string, ChatMessage>();
  const previousComments = new Map<string, ThreadComment>();
  if (previous) {
    for (const message of previous.messages) previousMessages.set(message.id, message);
    for (const comments of previous.threads.values()) {
      for (const comment of comments) previousComments.set(comment.id, comment);
    }
  }
  const reactions = new Map<string, Map<string, { url?: string; authors: Set<string> }>>();
  const authorDeleted = new Set<string>();
  for (const effect of effects) {
    if (effect.kind !== 5) continue;
    for (const tag of effect.tags) if (tag[0] === "e") authorDeleted.add(`${effect.pubkey}:${tag[1]}`);
  }

  for (const { rumor: r, edit, content } of visible) {
    const old = previousMessages.get(r.id) ?? previousComments.get(r.id);
    const attachments = old?.raw === r ? old.attachments : [...parseImeta(r.tags).values()];
    const emojiTags = (edit ?? r).tags.filter((t) => t[0] === "emoji");
    const stableEmojiTags = old && sameItems(old.emojiTags, emojiTags) ? old.emojiTags : emojiTags;
    if (r.kind === MESSAGE) {
      const prior = previousMessages.get(r.id);
      if (prior && prior.raw === r && prior.edited === (edit ? content : undefined) &&
        prior.emojiTags === stableEmojiTags) {
        messages.set(r.id, prior);
        continue;
      }
      const q = r.tags.find((t) => t[0] === "q");
      messages.set(r.id, {
        id: r.id, author: r.pubkey, content: r.content, ms: rumorMs(r),
        deleted: false, edited: edit ? content : undefined,
        replyTo: q ? { id: q[1], author: q[3] ?? "" } : undefined,
        threadReplyCount: 0, reactions: [], attachments,
        emojiTags: stableEmojiTags, raw: r,
      });
    } else if (r.kind === COMMENT) {
      const prior = previousComments.get(r.id);
      if (prior && prior.raw === r && prior.content === content && prior.emojiTags === stableEmojiTags) {
        const comments = threads.get(prior.root.id) ?? [];
        comments.push(prior);
        threads.set(prior.root.id, comments);
        continue;
      }
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
    const grouped = reactions.get(msg.id);
    const count = threads.get(msg.id)?.length ?? 0;
    // Compare before materializing arrays: unchanged siblings keep their rows,
    // reaction arrays and authors arrays, rather than allocating then discarding.
    let same = msg.reactions.length === (grouped?.size ?? 0);
    let index = 0;
    if (same && grouped) for (const [emoji, { url, authors }] of grouped) {
      const old = msg.reactions[index++];
      if (old.emoji !== emoji || old.url !== url || old.count !== authors.size) { same = false; break; }
      let authorIndex = 0;
      for (const author of authors) if (old.authors[authorIndex++] !== author) { same = false; break; }
      if (!same) break;
    }
    if (!same || msg.threadReplyCount !== count) {
      const nextReactions = same ? msg.reactions : [...(grouped ?? [])].map(([emoji, { url, authors }]) => ({
        emoji, url, count: authors.size, authors: [...authors],
      }));
      messages.set(msg.id, { ...msg, reactions: nextReactions, threadReplyCount: count });
    }
  }
  for (const [rootId, comments] of threads) {
    comments.sort(compareRows);
    const old = previous?.threads.get(rootId);
    threads.set(rootId, old && sameItems(old, comments) ? old : comments);
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
