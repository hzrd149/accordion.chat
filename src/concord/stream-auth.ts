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
// registry of the stream keys the client currently holds; the relay-auth
// watcher signs one kind-22242 event per registered key on each challenge, so a
// connection ends up authenticated as every stream it will query. Signing is
// local (raw secret keys) — it never touches the user's signer / bunker.
//
// NB: this is NOT part of the frozen Concord spec (CORD-01..06 say nothing
// about NIP-42) — it is a relay-access convention shared with armada.

import { finalizeEvent } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";
import type { GroupKey } from "./crypto";

/** pubkey (x-only hex) → the stream secret key that authenticates it. */
const registry = new Map<string, Uint8Array>();

type Listener = (added: string[]) => void;
const listeners = new Set<Listener>();

/** Register stream keys (idempotent). Returns the pubkeys newly added. */
export function registerStreamKeys(keys: GroupKey[]): string[] {
  const added: string[] = [];
  for (const k of keys) {
    if (registry.has(k.pk)) continue;
    registry.set(k.pk, k.sk);
    added.push(k.pk);
  }
  if (added.length > 0) for (const l of listeners) l(added);
  return added;
}

export function isStreamPubkey(pubkey: string): boolean {
  return registry.has(pubkey);
}

export function streamPubkeys(): string[] {
  return [...registry.keys()];
}

/** Subscribe to registry growth (fires with newly-added pubkeys). */
export function onStreamKeysAdded(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Sign the kind-22242 AUTH events for the given (default: all) registered
 * stream keys against `challenge` + `relayUrl`. Local signing, no user prompt.
 */
export function signStreamAuths(
  challenge: string,
  relayUrl: string,
  pubkeys: Iterable<string> = registry.keys(),
): NostrEvent[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const out: NostrEvent[] = [];
  for (const pk of pubkeys) {
    const sk = registry.get(pk);
    if (!sk) continue;
    out.push(
      finalizeEvent(
        {
          kind: 22242,
          content: "",
          tags: [
            ["relay", relayUrl],
            ["challenge", challenge],
          ],
          created_at: createdAt,
        },
        sk,
      ),
    );
  }
  return out;
}

/** Test seam: forget every registered stream key. */
export function _resetStreamAuthRegistry(): void {
  registry.clear();
}
