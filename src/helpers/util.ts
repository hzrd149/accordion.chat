import { nip19 } from "nostr-tools";

const COLORS = ["#5865f2", "#23a559", "#f0b232", "#eb459e", "#00a8fc", "#f23f42", "#9b59b6", "#e67e22"];

export function colorFor(pubkey: string): string {
  let h = 0;
  for (let i = 0; i < pubkey.length; i++) h = (h * 31 + pubkey.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function initials(pubkey: string): string {
  return pubkey.slice(0, 2).toUpperCase();
}

export function shortNpub(pubkey: string): string {
  try {
    const npub = nip19.npubEncode(pubkey);
    return npub.slice(0, 10) + "…" + npub.slice(-4);
  } catch {
    return pubkey.slice(0, 8) + "…";
  }
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  return `${d.toLocaleDateString([], { month: "numeric", day: "numeric", year: "2-digit" })} ${time}`;
}

/** Bare clock time (e.g. "3:41 PM") — used for the hover timestamp on grouped messages. */
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Groups consecutive messages into avatar "bubbles" — Discord/Slack style. A new
 * group starts when the author changes or the gap since the *previous* message
 * exceeds `gapMs` (clock resets on each message, so an active thread stays one
 * group). Messages must already be in chronological order.
 */
export function groupMessages<T extends { author: string; ms: number }>(
  messages: T[],
  gapMs = 2 * 60 * 1000,
): T[][] {
  const groups: T[][] = [];
  for (const m of messages) {
    const group = groups[groups.length - 1];
    const prev = group?.[group.length - 1];
    if (group && prev && prev.author === m.author && m.ms - prev.ms < gapMs) group.push(m);
    else groups.push([m]);
  }
  return groups;
}
