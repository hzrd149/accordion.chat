import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, of, Subject } from "rxjs";
import type { ConcordPlaneSyncCoverage, JoinMaterial } from "@applesauce/concord";
import { buildInviteLink } from "@applesauce/concord/helpers";

const mocks = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  engines: [] as FakeCommunity[],
  pools: [] as { close: ReturnType<typeof vi.fn>; add$: Subject<unknown> }[],
  loaders: [] as { stop: ReturnType<typeof vi.fn> }[],
  validOwner: true,
  inviteEvents: [] as unknown[],
  inviteBundle: {} as Record<string, unknown>,
  inviteLive: true,
}));

class FakeCommunity {
  material: JoinMaterial;
  phase$ = new BehaviorSubject("syncing");
  syncCoverage$ = new BehaviorSubject(new Map<string, ConcordPlaneSyncCoverage>());
  privateChannelStatus$ = new BehaviorSubject(new Map<string, { phase: string }>());
  metadata$ = new BehaviorSubject(undefined);
  dispose = vi.fn();
  start = vi.fn(async () => {});
  constructor(options: { material: JoinMaterial }) {
    this.material = options.material;
    mocks.engines.push(this);
  }
}

class FakeClient {
  options: Record<string, unknown>;
  communities$ = new BehaviorSubject<{ material: JoinMaterial }[]>([]);
  diagnostics$ = new Subject<{ stage: string }>();
  memberships$ = new BehaviorSubject({ knowledge: "unknown", locked: false, entries: [] as unknown[] });
  dispose = vi.fn();
  start = vi.fn(async () => {});
  memberships() { return this.memberships$.value; }
  getCommunity(id: string) { return mocks.engines.find((engine) => engine.material.community_id === id); }
  constructor(options: Record<string, unknown>) { this.options = options; mocks.clients.push(this); }
}

vi.mock("@applesauce/concord", () => ({
  ConcordClient: FakeClient, ConcordCommunity: FakeCommunity,
  KeyValue: { memoryStorage: () => ({}) },
}));
vi.mock("@applesauce/concord/helpers", async (original) => ({
  ...await original<object>(), verifyOwner: () => mocks.validOwner,
}));
vi.mock("applesauce-relay", () => ({
  RelayPool: class {
    add$ = new Subject();
    close = vi.fn();
    request = vi.fn(() => of(...mocks.inviteEvents));
    constructor() { mocks.pools.push(this); }
  },
}));
vi.mock("@applesauce/concord/casts", () => ({
  ConcordInviteBundle: class {
    get live() { return mocks.inviteLive; }
    unlock() { return mocks.inviteBundle; }
  },
}));
vi.mock("applesauce-loaders/loaders", () => ({
  createEventLoaderForStore: () => {
    const loader = { stop: vi.fn() };
    mocks.loaders.push(loader);
    return loader;
  },
}));

const material = { community_id: "community", name: "Test community" } as JoinMaterial;
const signer = { getPublicKey: async () => "pubkey", signEvent: vi.fn() };
const plane = (state: ConcordPlaneSyncCoverage["state"], lane: "current" | "history" = "current"): ConcordPlaneSyncCoverage =>
  ({ author: lane, lane, state, relays: {}, retained: 5 });

// Imported after mock registration; factories reference classes only when called.
const { hasCompleteCoverage, startConcordBenchmark: startRuntime } = await import("../src/services/concord-benchmark-runtime");
function startConcordBenchmark(...args: Parameters<typeof startRuntime> extends [...infer A, unknown] ? A : never) {
  return startRuntime(...args, { verification: "javascript", verifyEvent: () => true, lookupRelays: ["wss://lookup.example"] });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.clients.length = mocks.engines.length = mocks.pools.length = mocks.loaders.length = 0;
  mocks.validOwner = true;
  mocks.inviteEvents = [];
  mocks.inviteBundle = { ...material, channels: [], relays: ["wss://community.example"] };
  mocks.inviteLive = true;
});
afterEach(() => { vi.useRealTimers(); });

describe("cold-sync completion", () => {
  it("requires live readiness and complete coverage of every current and historical plane", () => {
    const coverage = new Map([["current", plane("complete")], ["history", plane("syncing", "history")]]);
    expect(hasCompleteCoverage("live", coverage)).toBe(false);
    coverage.set("history", plane("incomplete", "history"));
    expect(hasCompleteCoverage("live", coverage)).toBe(false);
    coverage.set("history", plane("error", "history"));
    expect(hasCompleteCoverage("live", coverage)).toBe(false);
    coverage.set("history", plane("complete", "history"));
    expect(hasCompleteCoverage("live", coverage)).toBe(true);
    expect(hasCompleteCoverage("syncing", coverage)).toBe(false);
    expect(hasCompleteCoverage("live", new Map())).toBe(false);
  });

  it("waits for private engines and resets the settlement period on new historical work", async () => {
    const update = vi.fn();
    startConcordBenchmark(signer, { kind: "community", material }, 10_000, update);
    await vi.advanceTimersByTimeAsync(0);
    const engine = mocks.engines[0];
    engine.phase$.next("live");
    engine.privateChannelStatus$.next(new Map([["private", { phase: "syncing" }]]));
    engine.syncCoverage$.next(new Map([["current", plane("complete")]]));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(update.mock.lastCall?.[0].status).toBe("running");
    engine.privateChannelStatus$.next(new Map([["private", { phase: "live" }]]));
    await vi.advanceTimersByTimeAsync(500);
    engine.syncCoverage$.next(new Map([["history", plane("syncing", "history")]]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update.mock.lastCall?.[0].status).toBe("running");
    engine.syncCoverage$.next(new Map([["history", plane("complete", "history")]]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update.mock.lastCall?.[0].status).toBe("complete");
    expect(engine.dispose).toHaveBeenCalledOnce();
    expect(mocks.pools[0].close).toHaveBeenCalledOnce();
    expect(mocks.loaders[0].stop).toHaveBeenCalledOnce();
    expect(signer.signEvent).not.toHaveBeenCalled();
  });

  it("does not call an unknown or locked list complete, including an apparently empty list", async () => {
    const update = vi.fn();
    startConcordBenchmark(signer, { kind: "list" }, 10_000, update);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(update.mock.lastCall?.[0].status).toBe("running");
    const client = mocks.clients[0];
    expect(client.options).toMatchObject({
      autoUnlock: true, autoSaveCommunityList: false, watchDirectInvites: false,
      pinUpkeep: false, historySync: "background",
    });
    client.memberships$.next({ knowledge: "complete", locked: true, entries: [] });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(update.mock.lastCall?.[0].status).toBe("running");
    client.memberships$.next({ knowledge: "confirmed-empty", locked: false, entries: [] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update.mock.lastCall?.[0].status).toBe("complete");
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it("waits for every listed membership to have an engine and complete history", async () => {
    const update = vi.fn();
    startConcordBenchmark(signer, { kind: "list" }, 10_000, update);
    await vi.advanceTimersByTimeAsync(0);
    const client = mocks.clients[0];
    client.memberships$.next({ knowledge: "complete", locked: false, entries: [{}] });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(update.mock.lastCall?.[0].status).toBe("running");
    const engine = new FakeCommunity({ material });
    client.communities$.next([{ material }]);
    engine.phase$.next("live");
    engine.syncCoverage$.next(new Map([["history", plane("incomplete", "history")]]));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(update.mock.lastCall?.[0].status).toBe("running");
    engine.syncCoverage$.next(new Map([["history", plane("complete", "history")]]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(update.mock.lastCall?.[0].status).toBe("complete");
    expect(update.mock.lastCall?.[0].communities[0].retained).toBe(5);
  });

  it("counts duplicate relay deliveries and their payload bytes without retaining event contents", async () => {
    const update = vi.fn();
    const run = startConcordBenchmark(signer, { kind: "community", material }, 2_000, update);
    await vi.advanceTimersByTimeAsync(0);
    const relay = { message$: new Subject<unknown>() };
    mocks.pools[0].add$.next(relay);
    const message = ["EVENT", "subscription", { content: "secret plaintext must not appear in results" }];
    relay.message$.next(["EOSE", "subscription"]);
    relay.message$.next(message);
    relay.message$.next(message);
    run.cancel();
    const report = update.mock.lastCall?.[0];
    expect(report.receivedEvents).toBe(2);
    expect(report.receivedEventBytes).toBe(new TextEncoder().encode(JSON.stringify(message)).byteLength * 2);
    expect(JSON.stringify(report)).not.toContain("secret plaintext");
    relay.message$.next(message);
    expect(update.mock.lastCall?.[0].receivedEvents).toBe(2);
  });

  it("preserves partial results on timeout and closes resources exactly once", async () => {
    const update = vi.fn();
    const run = startConcordBenchmark(signer, { kind: "community", material }, 2_000, update);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(update.mock.lastCall?.[0]).toMatchObject({ status: "timeout", communities: [{ phase: "syncing" }] });
    run.cancel();
    expect(mocks.engines[0].dispose).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels safely before the signer's pending public key resolves", async () => {
    let resolve!: (key: string) => void;
    const update = vi.fn();
    const run = startConcordBenchmark({
      ...signer, getPublicKey: () => new Promise<string>((done) => { resolve = done; }),
    }, { kind: "community", material }, 2_000, update);
    run.cancel();
    resolve("pubkey");
    await vi.advanceTimersByTimeAsync(0);
    expect(update.mock.lastCall?.[0].status).toBe("cancelled");
    expect(mocks.engines).toHaveLength(0);
    expect(mocks.pools[0].close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses fresh resources for every run and reports failures without secret-bearing exceptions", async () => {
    mocks.validOwner = false;
    const update = vi.fn();
    startConcordBenchmark(signer, { kind: "community", material }, 2_000, update);
    await vi.advanceTimersByTimeAsync(0);
    expect(update.mock.lastCall?.[0].status).toBe("error");
    const firstPool = mocks.pools[0];
    const run = startConcordBenchmark(signer, { kind: "list" }, 2_000, update);
    expect(mocks.pools[1]).not.toBe(firstPool);
    mocks.clients[0].diagnostics$.next({ stage: "decrypt" });
    run.cancel();
    expect(update.mock.lastCall?.[0].diagnostics).toEqual({ decrypt: 1 });
    expect(JSON.stringify(update.mock.lastCall?.[0])).not.toContain("community_root");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["live", "revoked", "expired", "missing"] as const)(
    "reads a %s invite without starting an account client or publishing a Join",
    async (state) => {
      const pubkey = "cd".repeat(32);
      const url = buildInviteLink("https://accordion.example", pubkey, new Uint8Array(16), ["wss://bootstrap.example"]);
      mocks.inviteEvents = state === "missing" ? [] : [{
        id: "ab".repeat(32), pubkey, sig: "ef".repeat(64),
        created_at: Math.floor(Date.now() / 1_000), kind: 33301,
        tags: [["d", ""], ["vsk", state === "revoked" ? "9" : "6"]], content: "encrypted",
      }];
      mocks.inviteLive = state !== "revoked";
      if (state === "expired") mocks.inviteBundle.expires_at = Date.now() - 10_000;
      const update = vi.fn();
      const run = startConcordBenchmark(signer, { kind: "invite", url }, 10_000, update);
      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.clients).toHaveLength(0);
      if (state === "live") {
        expect(mocks.engines).toHaveLength(1);
        expect(mocks.engines[0].start).toHaveBeenCalledOnce();
        expect(update.mock.lastCall?.[0].status).toBe("running");
        run.cancel();
      } else {
        expect(mocks.engines).toHaveLength(0);
        expect(update.mock.lastCall?.[0].status).toBe("error");
      }
      expect(signer.signEvent).not.toHaveBeenCalled();
      expect(mocks.pools[0].close).toHaveBeenCalledOnce();
    },
  );

  it.each([NaN, 0, 999, 900_001])("rejects invalid timeout %s before allocating resources", (timeout) => {
    expect(() => startConcordBenchmark(signer, { kind: "list" }, timeout, vi.fn())).toThrow("timeout");
    expect(mocks.pools).toHaveLength(0);
  });
});
