// Automatic NIP-42 authentication to community relays.
//
// Concord traffic is addressed to derived stream pubkeys, not the user, and
// auth-gating relays (ditto's `AUTH_KINDS` includes 1059) require EVERY author
// in a 1059 REQ to be an authenticated pubkey on the connection. So we
// authenticate AS each stream key we hold (see `stream-auth.ts`), plus the
// user's own key.
//
// Applesauce's REQ pipeline can pause on `auth-required` and retry, but its gate
// is a single `authenticated$` boolean — it assumes ONE signer per connection
// and flips true after the FIRST successful AUTH. Concord authenticates AS MANY
// stream keys on one connection, so that boolean can't tell us whether *every*
// queried author is authenticated. We therefore track authentication OURSELVES,
// per (relay, challenge, stream-pubkey).
//
// The stream-key AUTH is driven per-relay, from inside `authedFilters$`, off the
// relay's OWN `challenge$` — NOT the pool-wide `status$`. (`pool.status$` is a
// `shareReplay(1)`+`switchMap` over the relay set; an early subscriber, like a
// global watcher started at login, stops receiving updates for relays added
// later — so it never sees a community's relay and never authenticates it. The
// relay object's `challenge$` BehaviorSubject has no such problem.) Every
// gift-wrap REQ is then held behind `authedFilters$` until all of its authors
// have a confirmed AUTH-OK on the relay's current challenge; a reconnect issues
// a fresh challenge, re-authenticates, and re-issues the REQ.

import { BehaviorSubject, Subscription, combineLatest, merge } from "rxjs";
import { distinctUntilChanged, filter, ignoreElements, map, tap } from "rxjs/operators";
import type { Observable } from "rxjs";
import type { Relay, RelayStatus } from "applesauce-relay";
import { pool } from "../nostr";
import type { Signer } from "./stream";
import { signStreamAuths, streamKeysVersion$, streamPubkeys } from "./stream-auth";

// Per-relay authentication tracking, keyed by the relay's NORMALIZED url.
// `authed$` holds the stream pubkeys with a confirmed AUTH-OK on the *current*
// challenge; a challenge change (reconnect) resets it.
interface RelayAuthTrack {
  challenge: string | null;
  authed$: BehaviorSubject<Set<string>>;
  userAuthed: boolean;
  /** guards against overlapping stream-auth runs on the same relay */
  authing: boolean;
}
const tracks = new Map<string, RelayAuthTrack>();

function trackFor(url: string): RelayAuthTrack {
  let t = tracks.get(url);
  if (!t) {
    t = { challenge: null, authed$: new BehaviorSubject<Set<string>>(new Set()), userAuthed: false, authing: false };
    tracks.set(url, t);
  }
  return t;
}

/** Adopt a challenge, resetting the authenticated set when it changes (reconnect). */
function setChallenge(url: string, challenge: string): RelayAuthTrack {
  const t = trackFor(url);
  if (t.challenge !== challenge) {
    t.challenge = challenge;
    t.userAuthed = false;
    t.authed$.next(new Set());
  }
  return t;
}

function markAuthed(url: string, pubkey: string): void {
  const t = trackFor(url);
  if (t.authed$.value.has(pubkey)) return;
  const next = new Set(t.authed$.value);
  next.add(pubkey);
  t.authed$.next(next);
}

/** Authenticate (locally, no prompt) as every registered stream key not yet
 *  authed on `relay`'s current challenge. Idempotent and self-guarded so the
 *  challenge / new-keys triggers can both fire it without racing. */
async function authenticateStreamKeys(relay: Relay, challenge: string): Promise<void> {
  const track = setChallenge(relay.url, challenge);
  if (track.authing) return;
  track.authing = true;
  try {
    let pending = streamPubkeys().filter((pk) => !track.authed$.value.has(pk));
    // Re-check after each await: keys may register (channels fold in) mid-run.
    while (pending.length > 0 && track.challenge === challenge) {
      for (const authEvent of signStreamAuths(challenge, relay.url, pending)) {
        try {
          const res = await relay.auth(authEvent);
          if (res.ok) markAuthed(relay.url, authEvent.pubkey);
        } catch (err) {
          console.warn(`stream-key AUTH to ${relay.url} failed`, err);
        }
      }
      pending = streamPubkeys().filter((pk) => !track.authed$.value.has(pk));
    }
  } finally {
    track.authing = false;
  }
}

/**
 * A filter observable for a gift-wrap REQ that (a) drives stream-key AUTH on the
 * relay whenever it presents a challenge or new stream keys register, and (b)
 * holds `filters` back until it is safe to query `authors` from `url`: either
 * the relay presents a challenge and every author has a confirmed AUTH-OK on it,
 * or the relay is connected and never challenged (no auth required). Emits once
 * per distinct challenge, so a reconnect re-issues the (re-authenticated) REQ.
 * Pass this straight to `relay.subscription(...)` — subscribing opens the
 * connection (the REQ pipeline connects eagerly), which lets the challenge
 * arrive and the auth driver resolve.
 */
export function authedFilters$<T>(url: string, authors: string[], filters: T): Observable<T> {
  const relay = pool.relay(url);
  const track = trackFor(relay.url);

  // Side-effect only: keep the relay authenticated as all held stream keys.
  // Re-runs on every challenge (connect/reconnect) and whenever keys register.
  const auth$ = combineLatest([relay.challenge$, streamKeysVersion$]).pipe(
    tap(([challenge]) => {
      if (challenge) void authenticateStreamKeys(relay, challenge);
    }),
    ignoreElements(),
  ) as Observable<T>;

  const gate$ = combineLatest([relay.connected$, relay.challenge$, track.authed$]).pipe(
    filter(([connected, challenge, authed]) =>
      challenge ? authors.every((pk) => authed.has(pk)) : connected,
    ),
    // Collapse to the challenge so we emit once per challenge (not on every later
    // same-challenge auth), but still re-emit after a reconnect.
    map(([, challenge]) => challenge ?? ""),
    distinctUntilChanged(),
    map(() => filters),
  );

  return merge(auth$, gate$);
}

/**
 * Answer NIP-42 challenges with the USER's key so gating relays accept the
 * user's own published events (the Community List, invite bundles, …). Stream
 * reads authenticate per-relay via {@link authedFilters$}; this covers only the
 * user-authored write path. We watch `pool.status$` here (fine for the fixed set
 * of publish relays connected up front) and authenticate once per challenge when
 * the relay requires it.
 */
export function autoAuthenticate(signer: Signer): Subscription {
  const inflight = new Set<string>();

  async function answerUser(url: string, challenge: string): Promise<void> {
    const track = setChallenge(url, challenge);
    if (track.userAuthed) return;
    track.userAuthed = true;
    try {
      await pool.relay(url).authenticate(signer);
    } catch (err) {
      console.warn(`user AUTH to ${url} failed`, err);
      track.userAuthed = false;
    }
  }

  const statusSub = pool.status$.subscribe((statuses: Record<string, RelayStatus>) => {
    for (const [url, status] of Object.entries(statuses)) {
      const challenge = status.challenge;
      if (!challenge) continue;
      if (!status.authRequiredForRead && !status.authRequiredForPublish) continue;
      if (inflight.has(url)) continue;
      const track = setChallenge(url, challenge);
      if (track.userAuthed) continue;
      inflight.add(url);
      answerUser(url, challenge).finally(() => inflight.delete(url));
    }
  });

  const sub = new Subscription();
  sub.add(statusSub);
  return sub;
}

/** Test seam: forget every relay's tracked auth state. */
export function _resetRelayAuthTracking(): void {
  tracks.clear();
}
