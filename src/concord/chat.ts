// Chat Plane rumor builders (CORD-03 §3). Every chat rumor commits the
// channel_id and epoch it was written for; a receiver checks both against the
// key that opened the wrap and drops a mismatch.

import type { RumorTemplate } from "./stream";
import { KIND } from "./types";

function base(channelId: string, epoch: number): string[][] {
  return [
    ["channel", channelId],
    ["epoch", String(epoch)],
    ["ms", String(Date.now() % 1000)],
  ];
}

export function messageRumor(
  channelId: string,
  epoch: number,
  text: string,
  replyTo?: { id: string; author: string },
): RumorTemplate {
  const tags = base(channelId, epoch);
  if (replyTo) tags.push(["q", replyTo.id, "", replyTo.author]);
  return { kind: KIND.MESSAGE, content: text, tags };
}

export function reactionRumor(
  channelId: string,
  epoch: number,
  target: { id: string; author: string; kind: number },
  emoji: string,
): RumorTemplate {
  const tags = base(channelId, epoch);
  tags.push(["e", target.id], ["p", target.author], ["k", String(target.kind)]);
  return { kind: KIND.REACTION, content: emoji, tags };
}

export function deleteRumor(channelId: string, epoch: number, targetId: string, targetKind = 9): RumorTemplate {
  const tags = base(channelId, epoch);
  tags.push(["e", targetId], ["k", String(targetKind)]);
  return { kind: KIND.DELETE, content: "", tags };
}

export function editRumor(channelId: string, epoch: number, targetId: string, newText: string): RumorTemplate {
  const tags = base(channelId, epoch);
  tags.push(["e", targetId]);
  return { kind: KIND.EDIT, content: newText, tags };
}

/** Validate a decoded chat rumor's channel/epoch binding (CORD-03 §3). */
export function checkChatBinding(tags: string[][], channelId: string, epoch: number): boolean {
  const ch = tags.find((t) => t[0] === "channel")?.[1];
  const ep = tags.find((t) => t[0] === "epoch")?.[1];
  return ch === channelId && ep === String(epoch);
}
