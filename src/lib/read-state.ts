import { useEffect, useState } from "react";

/**
 * Per-channel read markers — the "last read" cursor behind the unread badges and
 * the new-messages divider. Mirrors the theme.ts / dev-mode.ts pattern: state
 * persisted to localStorage, a setter that notifies mounted hooks via a window
 * event, and a `useReadState` hook so any component re-renders when it changes.
 *
 * Local-only, by design. The Concord spec has no read-marker concept (nothing in
 * CORD-01…07), so this is client state, not protocol state. Syncing it would mean
 * a bare replaceable whose `created_at` churns every time you read a message —
 * a per-user activity beacon that the plane camouflage otherwise avoids. So read
 * state stays on the device and never touches a relay.
 *
 * Keyed per-pubkey: the AccountManager supports multiple accounts, and one
 * account's unread state must not leak into another's.
 *
 * Cursors are `ms` (the fold's `rumorMs`: `created_at * 1000` plus the CORD-02
 * `["ms", …]` tag remainder), NOT unix seconds — matching ChatMessage.ms, so
 * comparisons against a timeline can't race within a second.
 */

const EVENT = "accordion:readstatechange";

function keyFor(pubkey: string): string {
  return `accordion:read-state:${pubkey}`;
}

export interface CommunityReadState {
  /**
   * When this community was first seen by this client (ms). Acts as the implicit
   * last-read for any channel with no explicit cursor, which is what makes both
   * cases fall out of one number: history predating your join is older than the
   * baseline (reads as read, so joining doesn't dump hundreds of unread on you),
   * while a channel created after you joined is newer (correctly reads unread).
   */
  baseline: number;
  /** channelId → last-read cursor (ms). */
  channels: Record<string, number>;
  /** Last-read cursor for the community-wide Mentions view (ms). */
  mentions?: number;
}

/** cid → read state for that community. */
export type ReadState = Record<string, CommunityReadState>;

const EMPTY: ReadState = {};

/** The persisted map for an account, or empty when nothing is stored. */
export function getReadState(pubkey: string): ReadState {
  if (!pubkey) return EMPTY;
  try {
    const raw = localStorage.getItem(keyFor(pubkey));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY;
    return parsed as ReadState;
  } catch {
    /* localStorage may be unavailable (private mode), or the value may be
     * corrupt — either way fall back to "nothing read yet". */
    return EMPTY;
  }
}

function write(pubkey: string, state: ReadState) {
  try {
    localStorage.setItem(keyFor(pubkey), JSON.stringify(state));
  } catch {
    /* ignore persistence failures */
  }
  window.dispatchEvent(new Event(EVENT));
}

/**
 * The last-read cursor for a channel, falling back to the community baseline
 * (and to 0 for a community not yet seen — `ensureBaseline` is what stamps it).
 */
export function getLastRead(state: ReadState, cid: string, channelId: string): number {
  const community = state[cid];
  if (!community) return 0;
  return community.channels[channelId] ?? community.baseline;
}

/**
 * Stamp a community's baseline on first sight, so its pre-join history reads as
 * read. Idempotent — only the first call for a cid writes. Returns immediately if
 * the baseline is already set, so this is safe to call on every render pass.
 */
export function ensureBaseline(pubkey: string, cid: string, now: number = Date.now()) {
  if (!pubkey) return;
  const state = getReadState(pubkey);
  if (state[cid]) return;
  write(pubkey, { ...state, [cid]: { baseline: now, channels: {} } });
}

/**
 * Advance a channel's cursor to `ms`. No-ops when the stored cursor is already at
 * or past `ms`, so an out-of-order or backfilled message can never rewind read
 * state (and so a redundant call doesn't churn localStorage or re-render hooks).
 */
export function markRead(pubkey: string, cid: string, channelId: string, ms: number) {
  if (!pubkey) return;
  const state = getReadState(pubkey);
  const community = state[cid] ?? { baseline: ms, channels: {} };
  const current = community.channels[channelId] ?? community.baseline;
  if (current >= ms) return;
  write(pubkey, {
    ...state,
    [cid]: { ...community, channels: { ...community.channels, [channelId]: ms } },
  });
}

/**
 * The last-read cursor for the community-wide Mentions view, falling back to
 * the community baseline (so pre-join mentions read as read).
 */
export function getMentionsLastRead(state: ReadState, cid: string): number {
  const community = state[cid];
  if (!community) return 0;
  return community.mentions ?? community.baseline;
}

/**
 * Advance the mentions cursor to `ms`. Monotonic like `markRead`.
 */
export function markMentionsRead(pubkey: string, cid: string, ms: number) {
  if (!pubkey) return;
  const state = getReadState(pubkey);
  const community = state[cid] ?? { baseline: ms, channels: {} };
  const current = community.mentions ?? community.baseline;
  if (current >= ms) return;
  write(pubkey, {
    ...state,
    [cid]: { ...community, mentions: ms },
  });
}

/**
 * Drop a community's read state. Called when leaving a community, alongside
 * `deleteCommunityRumorCache` — the cursors are meaningless once the plaintext
 * they point into is gone, and would otherwise resurrect if the user rejoined.
 */
export function clearCommunityReadState(pubkey: string, cid: string) {
  if (!pubkey) return;
  const state = getReadState(pubkey);
  if (!state[cid]) return;
  const next = { ...state };
  delete next[cid];
  write(pubkey, next);
}

/** Read/subscribe to an account's read state; re-renders when it changes. */
export function useReadState(pubkey: string): ReadState {
  const [state, setState] = useState<ReadState>(() => getReadState(pubkey));

  useEffect(() => {
    const onChange = () => setState(getReadState(pubkey));
    // Re-read on pubkey change too: the effect body runs on mount and whenever
    // the account switches, so the state follows the active account.
    onChange();
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [pubkey]);

  return state;
}
