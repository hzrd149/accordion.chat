import { describe, expect, it, vi } from "vitest";
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure";
import { setVerifyWrappedEventMethod, verifyWrappedEvent } from "applesauce-core/helpers";
import { createBenchmarkVerifier } from "../src/helpers/benchmark-verification";

const calls = vi.hoisted(() => ({ javascript: 0, wasm: 0 }));
vi.mock("nostr-tools/pure", async (original) => {
  const actual = await original<typeof import("nostr-tools/pure")>();
  return { ...actual, verifyEvent: (event: Parameters<typeof actual.verifyEvent>[0]) => {
    calls.javascript++;
    return actual.verifyEvent(event);
  } };
});
vi.mock("nostr-tools/wasm", async (original) => {
  const actual = await original<typeof import("nostr-tools/wasm")>();
  return { ...actual, verifyEvent: (event: Parameters<typeof actual.verifyEvent>[0]) => {
    calls.wasm++;
    return actual.verifyEvent(event);
  } };
});
vi.mock("nostr-wasm", async (original) => {
  const actual = await original<typeof import("nostr-wasm")>();
  return { ...actual, initNostrWasm: vi.fn(actual.initNostrWasm) };
});

const signed = () => JSON.parse(JSON.stringify(finalizeEvent({
  kind: 1, created_at: 1, tags: [], content: "benchmark verification",
}, generateSecretKey())));

describe("benchmark crypto backends", () => {
  it.each(["javascript", "wasm"] as const)("fully verifies valid signatures and rejects tampering using %s", async (mode) => {
    const verify = await createBenchmarkVerifier(mode);
    const event = signed();
    const valid = () => structuredClone(event);
    const before = { ...calls };
    expect(verify(valid())).toBe(true);
    expect(verify({ ...valid(), sig: "0".repeat(128) })).toBe(false);
    expect(verify({ ...valid(), content: "tampered" })).toBe(false);
    expect(calls[mode]).toBe(before[mode] + 3);
    const other = mode === "wasm" ? "javascript" : "wasm";
    expect(calls[other]).toBe(before[other]);
  });

  it("skips both backends in the no-verification baseline", async () => {
    const verify = await createBenchmarkVerifier("none");
    const event = { ...signed(), sig: "0".repeat(128) };
    const before = { ...calls };
    expect(verify(event)).toBe(true);
    expect(calls).toEqual(before);
  });

  it.each(["javascript", "wasm", "none"] as const)(
    "can apply %s to the wrapped-seal path as well as public events",
    async (mode) => {
      const verify = await createBenchmarkVerifier(mode);
      // Represents the hook inside a worker's isolated module realm.
      setVerifyWrappedEventMethod(verify);
      const event = { ...signed(), sig: "0".repeat(128) };
      expect(verifyWrappedEvent(event)).toBe(mode === "none");
    },
  );

  it("reports unavailable WASM rather than silently measuring JavaScript", async () => {
    const { initNostrWasm } = await import("nostr-wasm");
    vi.mocked(initNostrWasm).mockRejectedValueOnce(new Error("unavailable"));
    await expect(createBenchmarkVerifier("wasm")).rejects.toThrow("unavailable");
  });
});
