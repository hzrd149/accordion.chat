import { describe, expect, it } from "vitest";
import { PublishRejectedError, requireAccepted } from "../src/lib/publish";
import { dmSyncStatus } from "../src/views/dm/sync-state";

describe("managed publish acknowledgements", () => {
  it("accepts partial delivery while retaining per-relay outcomes", () => {
    const responses = [
      { from: "wss://one.example", ok: false, message: "blocked" },
      { from: "wss://two.example", ok: true },
    ];
    expect(requireAccepted(responses)).toBe(responses);
  });

  it("rejects all-negative outcomes even though the pool promise resolved", () => {
    const responses = [{ from: "wss://one.example", ok: false, message: "auth-required" }];
    expect(() => requireAccepted(responses)).toThrow(PublishRejectedError);
    expect(() => requireAccepted(responses)).toThrow("auth-required");
  });

  it("does not treat an empty target/outcome list as successful", () => {
    expect(() => requireAccepted([])).toThrow("No relay accepted");
  });
});

describe("DM sync status", () => {
  it("keeps partial failures visible after a sync completes", () => {
    expect(dmSyncStatus({ loaded: 5, done: true, relays: {
      "wss://one.example": { relay: "wss://one.example", state: "error", count: 0, error: new Error("offline") },
      "wss://two.example": { relay: "wss://two.example", state: "complete", count: 5 },
    } })).toEqual({ received: 5, syncing: false, error: "wss://one.example: offline" });
  });

  it("does not confuse skipped or all-failed relays with empty successful history", () => {
    const state = dmSyncStatus({ loaded: 0, done: true, relays: {
      "wss://one.example": { relay: "wss://one.example", state: "skipped", count: 0 },
    } });
    expect(state.received).toBe(0);
    expect(state.syncing).toBe(false);
    expect(state.error).toContain("relay unavailable");
  });
});
