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
import { setVerifyWrappedEventMethod, verifiedSymbol, type VerifyEventMethod } from "applesauce-core/helpers";
import type { EventStore } from "applesauce-core";
import { OptimisticEventVerifier } from "applesauce-core/event-store";
import { verifyEvent as jsVerifyEvent } from "nostr-tools/pure";
import { signatureVerificationMode$ } from "./services/signature-verification";

type Verifier = NonNullable<EventStore["verifyEvent"]>;
type MemoEvent = Parameters<Verifier>[0] & { [verifiedSymbol]?: boolean };

/**
 * nostr-wasm's verifier, memoized like nostr-tools' pure verifier.
 *
 * `nostr-tools/wasm` never reads a cached result and marks events with its own
 * private symbol, so without this every repeated check of the same object (e.g.
 * applesauce-common's "cheap to repeat" seal verification) re-runs the Schnorr
 * check. Reading/writing applesauce-core's `verifiedSymbol` restores the cache
 * the default verifier provides. The optimistic verifier passes a fresh object,
 * so a cached mark can never bypass one of its sampled checks.
 */
export function verifyEventWasm(event: Parameters<Verifier>[0]): boolean {
  const memo = event as MemoEvent;
  const cached = memo[verifiedSymbol];
  if (typeof cached === "boolean") return cached;
  const valid = wasmVerifyEvent(event);
  memo[verifiedSymbol] = valid;
  return valid;
}

/**
 * Apply the persisted verification mode and initialize its WASM backend:
 *   - `eventStore.verifyEvent` — every event added to the shared store.
 *   - `setVerifyWrappedEventMethod` — the wrapped-event verifier applesauce-core's
 *     gift-wrap/zap helpers and the Concord seal path (`verifyWrappedEvent`) use.
 *
 * Non-blocking by design: until the WASM instantiates (a few ms), verification
 * uses a pure-JS backend in verifying modes. Resolves when initialization finishes.
 * RumorStores are untouched (they verify by re-hashing the id, not a signature).
 */
export async function enableWasmVerification(eventStore: EventStore): Promise<void> {
  // The base signature check for every verifying mode. Starts on pure JS and is
  // swapped to WASM once initialized; the optimistic verifier reads it through a
  // closure so its sampled checks pick up the swap without being rebuilt.
  let verify: Verifier = jsVerifyEvent;
  const optimistic = new OptimisticEventVerifier({
    verifyEvent: (event) => verify(event),
    storage: {
      getItem: (key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      },
      setItem: (key, value) => {
        try { localStorage.setItem(key, value); } catch { /* Optional trust persistence. */ }
      },
    },
  });
  const apply = () => {
    const mode = signatureVerificationMode$.value;
    const selected = mode === "none" ? () => true
      : mode === "optimistic" ? optimistic.verifyEvent : verify;
    eventStore.verifyEvent = selected;
    setVerifyWrappedEventMethod(selected as VerifyEventMethod);
  };
  // One subscription for the lifetime of the application's shared EventStore.
  signatureVerificationMode$.subscribe(apply);
  try {
    const wasm = await initNostrWasm();
    setNostrWasm(wasm);
    verify = verifyEventWasm;
    // Read the latest preference: it may have changed during initialization.
    apply();
    console.info("[concord] nostr-wasm signature verifier ready");
  } catch (err) {
    // Verifying modes retain the pure-JS backend; disabled mode stays disabled.
    console.warn("[concord] nostr-wasm init failed; using JS verification", err);
  }
}
