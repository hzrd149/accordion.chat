// Fast signature verification via nostr-wasm (libsecp256k1 compiled to WASM).
//
// nostr-tools' default `verifyEvent` verifies Schnorr signatures with the pure-JS
// `@noble/curves`, which dominates CPU when a Concord client decodes its planes:
// EVERY gift wrap (control/guestbook/every channel/voice presence) has its inner
// seal signature checked (`getWrapSeal → verifyWrappedEvent`), on top of ordinary
// public-event verification in the EventStore. Swapping in nostr-wasm's WASM
// verifier (~10–50× faster) is the single biggest win.
//
// nostr-wasm also hashes the event id in-WASM during verify, so the id-hash on the
// hot verification path rides along. (Event *creation* still hashes with @noble's
// sync sha256 — correct: WebCrypto's `subtle.digest` is async and its per-call
// overhead makes it slower than @noble for event-sized inputs, and it can't be
// used in nostr-tools' synchronous `getEventHash` anyway.)

import { initNostrWasm } from "nostr-wasm";
import { setNostrWasm, verifyEvent as wasmVerifyEvent } from "nostr-tools/wasm";
import { setVerifyWrappedEventMethod, type VerifyEventMethod } from "applesauce-core/helpers";
import type { EventStore } from "applesauce-core";

/**
 * Instantiate nostr-wasm and route all signature verification through it:
 *   - `eventStore.verifyEvent` — every event added to the shared store.
 *   - `setVerifyWrappedEventMethod` — the wrapped-event verifier applesauce-core's
 *     gift-wrap/zap helpers and the Concord seal path (`verifyWrappedEvent`) use.
 *
 * Non-blocking by design: until the WASM instantiates (a few ms), verification
 * falls back to the pure-JS defaults — correct, just slower. Resolves when live.
 * RumorStores are untouched (they verify by re-hashing the id, not a signature).
 */
export async function enableWasmVerification(eventStore: EventStore): Promise<void> {
  try {
    const wasm = await initNostrWasm();
    setNostrWasm(wasm);
    // nostr-wasm's verifier is structurally identical but nominally typed against
    // nostr-tools/wasm's own event types, so cast to applesauce's predicate shape.
    eventStore.verifyEvent = wasmVerifyEvent;
    setVerifyWrappedEventMethod(wasmVerifyEvent as unknown as VerifyEventMethod);
    console.info("[concord] nostr-wasm signature verification enabled");
  } catch (err) {
    // Leave the pure-JS verifiers in place — correct, just slower.
    console.warn("[concord] nostr-wasm init failed; using JS verification", err);
  }
}
