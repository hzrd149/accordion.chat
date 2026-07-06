// Automatic NIP-42 authentication to community relays.
//
// Concord traffic is addressed to derived stream pubkeys, not the user, and
// auth-gating relays (ditto's `AUTH_KINDS` includes 1059) require every author
// in a 1059 REQ to be authenticated on the connection. So we authenticate AS
// each stream key we hold (see `stream-auth.ts`), plus the user's own key.
//
// Applesauce's REQ pipeline already *pauses* on `auth-required` and auto-retries
// once `authenticated$` flips, and it correlates each AUTH's OK by event id — so
// we can send many AUTH messages on one connection. We only need to answer the
// challenges: watch `pool.status$`, and whenever a relay gates reads/writes
// behind auth, send an AUTH for every stream key it hasn't yet authenticated
// (and the user once). New stream keys fold in later (channels after the control
// fold) — `onStreamKeysAdded` re-runs the answer over the still-open connection.

import { Subscription } from "rxjs";
import type { RelayStatus } from "applesauce-relay";
import { pool } from "../nostr";
import type { Signer } from "./stream";
import { onStreamKeysAdded, signStreamAuths, streamPubkeys } from "./stream-auth";

interface RelayAuthState {
  challenge: string;
  streamAuthed: Set<string>; // stream pubkeys authed on this challenge
  userAuthed: boolean;
}

export function autoAuthenticate(signer: Signer): Subscription {
  const state = new Map<string, RelayAuthState>();
  const inflight = new Set<string>();
  let lastStatuses: Record<string, RelayStatus> = {};

  function stateFor(url: string, challenge: string): RelayAuthState {
    let s = state.get(url);
    // A reconnect issues a fresh challenge — start over for that connection.
    if (!s || s.challenge !== challenge) {
      s = { challenge, streamAuthed: new Set(), userAuthed: false };
      state.set(url, s);
    }
    return s;
  }

  async function answer(url: string, status: RelayStatus): Promise<void> {
    const challenge = status.challenge;
    if (!challenge) return;
    const s = stateFor(url, challenge);
    const relay = pool.relay(url);

    // 1. One AUTH per not-yet-authenticated stream key (local signing).
    const pending = streamPubkeys().filter((pk) => !s.streamAuthed.has(pk));
    if (pending.length > 0) {
      for (const authEvent of signStreamAuths(challenge, url, pending)) {
        try {
          const res = await relay.auth(authEvent);
          if (res.ok) s.streamAuthed.add(authEvent.pubkey);
        } catch (err) {
          console.warn(`stream-key AUTH to ${url} failed`, err);
        }
      }
    }

    // 2. Authenticate the user's own key once per challenge (enables publishing
    //    user-authored events like the Community List to gating relays).
    if (!s.userAuthed) {
      s.userAuthed = true;
      try {
        await relay.authenticate(signer);
      } catch (err) {
        console.warn(`user AUTH to ${url} failed`, err);
        s.userAuthed = false;
      }
    }
  }

  function evaluate(statuses: Record<string, RelayStatus>): void {
    for (const [url, status] of Object.entries(statuses)) {
      if (!status.challenge) continue;
      if (status.authenticated && status.authenticatedAs) {
        // Record whatever the relay reports as authenticated (best-effort).
      }
      if (!status.authRequiredForRead && !status.authRequiredForPublish) continue;
      if (inflight.has(url)) continue;

      const s = stateFor(url, status.challenge);
      const missingStream = streamPubkeys().some((pk) => !s.streamAuthed.has(pk));
      if (!missingStream && s.userAuthed) continue; // nothing left to answer

      inflight.add(url);
      answer(url, status).finally(() => inflight.delete(url));
    }
  }

  const statusSub = pool.status$.subscribe((statuses) => {
    lastStatuses = statuses;
    evaluate(statuses);
  });

  // When channels fold in and register their stream keys, re-answer the
  // still-open connections with the newly-held keys.
  const removeListener = onStreamKeysAdded(() => evaluate(lastStatuses));

  const sub = new Subscription();
  sub.add(statusSub);
  sub.add(removeListener);
  return sub;
}
