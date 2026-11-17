import { afterEach, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { verifyWrappedEvent } from "applesauce-core/helpers";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { enableWasmVerification } from "../src/crypto-wasm";
import { setSignatureVerificationMode } from "../src/services/signature-verification";

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
