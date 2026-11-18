import { afterEach, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { verifyWrappedEvent } from "applesauce-core/helpers";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { enableWasmVerification } from "../src/crypto-wasm";
import { setSignatureVerificationMode } from "../src/services/signature-verification";

// Spy on the WASM backend so tests can prove which verifier runs underneath.
const wasm = vi.hoisted(() => ({ calls: 0 }));
vi.mock("nostr-tools/wasm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools/wasm")>();
  return {
    ...actual,
    verifyEvent: (event: Parameters<typeof actual.verifyEvent>[0]) => {
      wasm.calls++;
      return actual.verifyEvent(event);
    },
  };
});

afterEach(() => {
  setSignatureVerificationMode("full");
  vi.restoreAllMocks();
});

it("applies mode changes to public and wrapped events, including during WASM startup", async () => {
  const store = new EventStore();
  const ready = enableWasmVerification(store);
  setSignatureVerificationMode("none");
  await ready;

  const signed = finalizeEvent(
    { kind: 1, created_at: 1, tags: [], content: "verification test" },
    generateSecretKey(),
  );
  // Fresh objects avoid nostr-tools' cached verification symbol.
  const valid = () => JSON.parse(JSON.stringify(signed));
  const invalid = () => ({ ...valid(), sig: "0".repeat(128) });
  expect(store.verifyEvent!(invalid())).toBe(true);
  expect(verifyWrappedEvent(invalid())).toBe(true);

  for (const mode of ["full", "optimistic"] as const) {
    setSignatureVerificationMode(mode);
    expect(store.verifyEvent!(valid())).toBe(true);
    expect(verifyWrappedEvent(valid())).toBe(true);
    expect(store.verifyEvent!(invalid())).toBe(false);
    expect(verifyWrappedEvent(invalid())).toBe(false);
    expect(store.verifyEvent!({ ...valid(), content: "tampered" })).toBe(false);
  }
});

it("uses the WASM verifier underneath full and optimistic verification", async () => {
  const store = new EventStore();
  await enableWasmVerification(store);
  // A distinct event per check: the optimistic verifier caches id+sig itself.
  let n = 0;
  const signed = () => finalizeEvent(
    { kind: 1, created_at: 2, tags: [], content: `wasm backend ${n++}` },
    generateSecretKey(),
  );

  for (const mode of ["full", "optimistic"] as const) {
    setSignatureVerificationMode(mode);
    // Events without seen relays are always fully checked by the optimistic verifier.
    for (const verify of [store.verifyEvent!, verifyWrappedEvent]) {
      const before = wasm.calls;
      expect(verify(JSON.parse(JSON.stringify(signed())))).toBe(true);
      expect(wasm.calls).toBe(before + 1);
    }
  }
});

it("memoizes WASM results on the event like the default verifier", async () => {
  const store = new EventStore();
  await enableWasmVerification(store);
  setSignatureVerificationMode("full");
  const event = JSON.parse(JSON.stringify(finalizeEvent(
    { kind: 1, created_at: 3, tags: [], content: "memo" },
    generateSecretKey(),
  )));
  const before = wasm.calls;
  expect(verifyWrappedEvent(event)).toBe(true);
  expect(verifyWrappedEvent(event)).toBe(true);
  expect(store.verifyEvent!(event)).toBe(true);
  expect(wasm.calls).toBe(before + 1);

  const bad = { ...JSON.parse(JSON.stringify(event)), sig: "0".repeat(128) };
  expect(verifyWrappedEvent(bad)).toBe(false);
  expect(verifyWrappedEvent(bad)).toBe(false);
  expect(wasm.calls).toBe(before + 2);
});
