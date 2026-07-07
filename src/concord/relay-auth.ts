// Automatic NIP-42 authentication to community relays.
//
// Concord traffic is addressed to derived stream pubkeys, not the user, and
// auth-gating relays (ditto's `AUTH_KINDS` includes 1059) require EVERY author
// in a 1059 REQ to be an authenticated pubkey on the connection. So we
// authenticate AS each stream key we hold (see `stream-auth.ts`), plus the
// user's own key.
//
// applesauce-relay now authenticates multiple pubkeys per connection natively:
// `relay.authenticate(signer)` builds/sends the kind-22242 and tracks per-pubkey
// state, `relay.isAuthenticated(pubkeys)` reports it, and a REQ opened with
// `waitForAuth: [...pubkeys]` is held until all of them are authenticated (and
// retried on a reconnect). The gating therefore lives at the subscription
// (see `client.subscribeWraps`); this module only DRIVES the authentication:
// it hands every held signer to `relay.authenticate` whenever a relay presents
// a challenge. Auth state resets on disconnect and a fresh challenge re-emits on
// reconnect, so simply re-running on each `challenge$` re-authenticates.

import { Subscription, combineLatest } from "rxjs";
import type { Relay } from "applesauce-relay";
import { pool } from "../nostr";
import type { Signer } from "./stream";
import { streamKeysVersion$, streamSigners } from "./stream-auth";

// One shared auth driver per relay URL, reference-counted. Both the control and
// channel gift-wrap subscriptions target the same relays and the same
// (whole-registry) stream keys, so a driver per subscription would send
// duplicate AUTHs; instead they share a single driver that lives as long as any
// subscription holds a reference.
interface Driver {
  sub: Subscription;
  refs: number;
}
const drivers = new Map<string, Driver>();

/**
 * Keep `relay` authenticated (NIP-42) as every registered stream key. Native
 * `relay.authenticate` handles the AUTH event and per-pubkey state; we re-run it
 * whenever the relay presents a fresh challenge (connect/reconnect) or new stream
 * keys register (a channel folds in after the connection is already open). A
 * single-flight guard plus a make-progress loop keeps concurrent triggers from
 * racing while still picking up keys registered mid-run. Returns a Subscription
 * that releases this caller's reference; the shared driver stops at zero refs.
 */
export function authenticateStreamKeys(relay: Relay): Subscription {
  let driver = drivers.get(relay.url);
  if (!driver) {
    let running = false;
    async function run(): Promise<void> {
      if (running) return;
      running = true;
      try {
        // Loop so keys registered mid-run get authenticated too; stop when a
        // full pass makes no progress (a persistently-rejecting relay won't spin).
        for (;;) {
          const pending = streamSigners().filter(({ pubkey }) => !relay.isAuthenticated(pubkey));
          if (!relay.challenge || pending.length === 0) break;
          let progressed = false;
          for (const { pubkey, signer } of pending) {
            if (relay.isAuthenticated(pubkey)) continue;
            try {
              const res = await relay.authenticate(signer);
              if (res.ok) progressed = true;
            } catch (err) {
              console.warn(`stream-key AUTH to ${relay.url} failed`, err);
            }
          }
          if (!progressed) break;
        }
      } finally {
        running = false;
      }
    }
    // `challenge$` re-emits on every (re)connect; `streamKeysVersion$` on new keys.
    const sub = combineLatest([relay.challenge$, streamKeysVersion$]).subscribe(() => void run());
    driver = { sub, refs: 0 };
    drivers.set(relay.url, driver);
  }
  driver.refs++;

  return new Subscription(() => {
    const d = drivers.get(relay.url);
    if (!d) return;
    if (--d.refs <= 0) {
      d.sub.unsubscribe();
      drivers.delete(relay.url);
    }
  });
}

/**
 * Answer NIP-42 challenges with the USER's key so gating relays accept the
 * user's own published events (the Community List, invite bundles, …). Stream
 * reads authenticate per-relay via {@link authenticateStreamKeys}; this covers
 * only the user-authored write path across the fixed publish-relay set connected
 * up front. Native per-pubkey auth state (`isAuthenticated`) provides
 * idempotency and resets on reconnect, so we simply (re-)authenticate whenever a
 * relay requires auth and the user isn't yet authenticated on it.
 */
export function autoAuthenticate(signer: Signer, pubkey: string): Subscription {
  const inflight = new Set<string>();

  return pool.status$.subscribe((statuses) => {
    for (const [url, status] of Object.entries(statuses)) {
      if (!status.challenge) continue;
      if (!status.authRequiredForRead && !status.authRequiredForPublish) continue;
      const relay = pool.relay(url);
      if (relay.isAuthenticated(pubkey) || inflight.has(url)) continue;
      inflight.add(url);
      relay
        .authenticate(signer)
        .catch((err) => console.warn(`user AUTH to ${url} failed`, err))
        .finally(() => inflight.delete(url));
    }
  });
}
