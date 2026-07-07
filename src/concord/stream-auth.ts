// Stream-key NIP-42 authentication (mirrors armada concord-v2 `streamAuth.ts`).
//
// Every Concord plane is kind-1059 traffic addressed to a DERIVED per-stream
// pubkey (control, guestbook, per-channel, dissolved, rekey) — never the user's
// identity. Relays that gate kind 1059 behind NIP-42 (e.g. ditto's default
// `AUTH_KINDS=4,1059`) require that EVERY `authors` entry in a 1059 REQ be an
// authenticated pubkey on the connection; the user's login can't satisfy that
// because the stream address isn't their pubkey.
//
// The client holds the stream SECRET keys (derived from community_root /
// channel keys), so it can NIP-42-authenticate AS each stream. This module is a
// registry of `PrivateKeySigner`s for the stream keys the client currently
// holds; the relay-auth driver hands each one to applesauce's native
// `relay.authenticate(signer)` on every challenge, so a connection ends up
// authenticated as every stream it will query. Signing is local (raw secret
// keys) — it never touches the user's signer / bunker.
//
// NB: this is NOT part of the frozen Concord spec (CORD-01..06 say nothing
// about NIP-42) — it is a relay-access convention shared with armada.

import { PrivateKeySigner } from "applesauce-signers";
import { BehaviorSubject } from "rxjs";
import type { GroupKey } from "./crypto";

/** pubkey (x-only hex) → the signer that NIP-42-authenticates it. */
const registry = new Map<string, PrivateKeySigner>();

/** Bumps whenever new stream keys register. Lets the per-relay auth driver
 * re-authenticate the newly-held keys on connections it already opened (a
 * channel folds in after the control plane is already subscribed). */
export const streamKeysVersion$ = new BehaviorSubject(0);

/** Register stream keys (idempotent). Returns the pubkeys newly added. */
export function registerStreamKeys(keys: GroupKey[]): string[] {
  const added: string[] = [];
  for (const k of keys) {
    if (registry.has(k.pk)) continue;
    registry.set(k.pk, new PrivateKeySigner(k.sk));
    added.push(k.pk);
  }
  if (added.length > 0) streamKeysVersion$.next(streamKeysVersion$.value + 1);
  return added;
}

export function streamPubkeys(): string[] {
  return [...registry.keys()];
}

/** Every registered stream key as a `(pubkey, signer)` pair, for feeding to
 *  applesauce's native `relay.authenticate(signer)`. */
export function streamSigners(): { pubkey: string; signer: PrivateKeySigner }[] {
  return [...registry.entries()].map(([pubkey, signer]) => ({ pubkey, signer }));
}

/** Test seam: forget every registered stream key. */
export function _resetStreamAuthRegistry(): void {
  registry.clear();
}
