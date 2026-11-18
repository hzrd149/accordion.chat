import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, Subject } from "rxjs";
import type { ConcordDiagnostic } from "@applesauce/concord";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  clients: [] as Array<{
    diagnostics$: Subject<ConcordDiagnostic>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    saveCommunityList: ReturnType<typeof vi.fn>;
    retryStorageCleanup: ReturnType<typeof vi.fn>;
    schedulePurge: ReturnType<typeof vi.fn>;
  }>,
  stores: [] as Array<{ close: ReturnType<typeof vi.fn> }>,
  failDrafts: false,
  order: [] as string[],
}));
vi.mock("../src/nostr", async () => {
  const { BehaviorSubject } = await import("rxjs");
  const active$ = new BehaviorSubject<{ id: string; pubkey: string } | null>(null);
  return { accounts: { active$, get active() { return active$.value; } }, eventStore: {}, pool: {} };
});
vi.mock("@applesauce/concord", async () => {
  const { Subject } = await import("rxjs");
  const store = () => {
    const value = { close: vi.fn(async () => { mocks.order.push("close"); }) };
    mocks.stores.push(value);
    return value;
  };
  return {
    ConcordClient: class {
      diagnostics$ = new Subject<ConcordDiagnostic>();
      start = vi.fn(async () => {});
      stop = vi.fn();
      dispose = vi.fn(() => { mocks.order.push("dispose"); });
      saveCommunityList = vi.fn(async () => {});
      retryStorageCleanup = vi.fn(async () => {});
      schedulePurge = vi.fn(() => vi.fn());
      constructor() { mocks.clients.push(this); }
    },
    Databases: { createIndexedDBDatabaseFactory: store },
    Drafts: { createIndexedDBDraftStore: () => {
      if (mocks.failDrafts) throw new Error("drafts unavailable");
      return store();
    } },
    Media: { createIndexedDBMediaStoreFactory: store },
    logger: { extend: vi.fn() },
  };
});
vi.mock("../src/services/concord-storage", () => ({
  createConcordStorage: () => {
    const value = { close: vi.fn(async () => { mocks.order.push("close"); }) };
    mocks.stores.push(value);
    return value;
  },
}));
vi.mock("../src/helpers/concord-uploader", () => ({ createConcordUploader: vi.fn() }));
vi.mock("../src/helpers/concord-decryption-cache", () => ({ createConcordDecryptionCache: vi.fn() }));
vi.mock("../src/services/concord-automation", () => ({ activeConcordAutomation: {} }));
vi.mock("../src/services/signer-activity", () => ({ observeSigner: vi.fn() }));
vi.mock("../src/voice/registry", () => ({ attachVoiceGc: () => vi.fn() }));
vi.mock("../src/services/user-search", () => ({ attachUserIndexGc: () => vi.fn() }));
vi.mock("../src/services/concord-sync-activity", () => ({ observeConcordSync: () => vi.fn() }));
vi.mock("../src/services/concord-media", () => ({
  attachMediaGc: () => vi.fn(), createMediaTransport: vi.fn(), retireLegacyImageCache: async () => {},
}));
// UI uses the same observable snapshot without simulating React's lifecycle.
vi.mock("applesauce-react/hooks", () => ({
  use$: (source: BehaviorSubject<unknown>) => {
    let value: unknown;
    const sub = source.subscribe((next) => { value = next; });
    sub.unsubscribe();
    return value;
  },
}));

import { accounts } from "../src/nostr";
import {
  concordState$, startConcord, stopConcord, retryConcord, syncCommunityKeys,
  retryConcordCleanup, dismissConcordDiagnostics,
} from "../src/services/concord";
import type { ConcordState } from "../src/services/concord";
import { finishAccountErasure, retireAccountResources } from "../src/services/account-lifecycle";
import { ConcordDiagnostics } from "../src/components/ConcordDiagnostics";

let latest: ConcordState;
// Explicit subscription keeps assertions independent of the React view.
const stateSub = concordState$.subscribe((value) => { latest = value; });
afterEach(async () => {
  stopConcord();
  await flush();
  vi.useRealTimers();
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const issue = (stage: ConcordDiagnostic["stage"] = "storage-cleanup", error = "disk unavailable") =>
  ({ stage, error, communityId: "community", key: "private-channel" }) as ConcordDiagnostic;
function activate(id = "a") {
  // The application uses full accounts; the lifecycle only needs identity here.
  accounts.active$.next({ id, pubkey: id.repeat(64) } as never);
  return mocks.clients.at(-1)!;
}
const html = () => renderToStaticMarkup(ConcordDiagnostics());

beforeEach(() => {
  vi.useFakeTimers();
  accounts.active$.next(null as never);
  mocks.clients.length = mocks.stores.length = mocks.order.length = 0;
  mocks.failDrafts = false;
  startConcord();
});

describe("service-owned Concord lifecycle", () => {
  it("starts once independently of UI subscriptions, with single-flight retry", async () => {
    const client = activate();
    startConcord();
    retryConcord();
    expect(mocks.clients).toHaveLength(1);
    expect(client.start).not.toHaveBeenCalled();
    const pending = Promise.withResolvers<void>();
    client.start.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(100);
    retryConcord();
    retryConcord();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.start).toHaveBeenCalledTimes(1);
    pending.reject(new Error("signer denied"));
    await flush();
    expect(latest.error).toBe("signer denied");
    retryConcord();
    await vi.advanceTimersByTimeAsync(100);
    expect(latest.status).toBe("ready");
  });

  it("cancels delayed starts and ignores late startup results after switching", async () => {
    const first = activate();
    const second = activate("b");
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const pending = Promise.withResolvers<void>();
    second.start.mockReturnValueOnce(pending.promise);
    await vi.advanceTimersByTimeAsync(100);
    const third = activate("c");
    pending.reject(new Error("old failure"));
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(first.start).not.toHaveBeenCalled();
    expect(second.dispose).toHaveBeenCalledTimes(1);
    expect(latest.client).toBe(third);
    expect(latest.status).toBe("ready");
    expect(latest.error).toBeUndefined();
  });

  it("registers an awaited logout barrier and disposes before closing all adapters", async () => {
    const client = activate();
    const pending = Promise.withResolvers<void>();
    mocks.stores[0].close.mockImplementationOnce(async () => {
      mocks.order.push("close");
      await pending.promise;
    });
    let closed = false;
    const retirement = retireAccountResources("a".repeat(64)).then(() => { closed = true; });
    await flush();
    expect(closed).toBe(false);
    expect(client.dispose).toHaveBeenCalledTimes(1);
    expect(mocks.order).toEqual(["dispose", "close", "close", "close", "close"]);
    pending.resolve();
    await retirement;
    retryConcord();
    await vi.advanceTimersByTimeAsync(100);
    expect(client.start).not.toHaveBeenCalled();
    stopConcord();
    await flush();
    expect(client.dispose).toHaveBeenCalledTimes(1);
    finishAccountErasure("a".repeat(64));
  });

  it("closes partial construction and allows recovery", async () => {
    mocks.failDrafts = true;
    activate();
    await flush();
    expect(latest.error).toBe("drafts unavailable");
    expect(mocks.stores[0].close).toHaveBeenCalledTimes(1);
    mocks.failDrafts = false;
    retryConcord();
    await vi.advanceTimersByTimeAsync(100);
    expect(latest.status).toBe("ready");
  });

  it("keeps key-sync operations single-flight and ignores retired completions", async () => {
    const client = activate();
    const pending = Promise.withResolvers<void>();
    client.saveCommunityList.mockReturnValue(pending.promise);
    const request = syncCommunityKeys();
    await syncCommunityKeys();
    expect(client.saveCommunityList).toHaveBeenCalledTimes(1);
    activate("b");
    pending.reject(new Error("old sync"));
    await request;
    expect(latest.syncing).toBe(false);
    expect(latest.syncError).toBeUndefined();
  });
});

describe("service-owned diagnostic recovery", () => {
  it("retains early cleanup failures beyond journal overflow and filters invite diagnostics", () => {
    const client = activate();
    client.diagnostics$.next(issue());
    for (let i = 0; i < 10; i++) client.diagnostics$.next(issue("material-persist", `error ${i}`));
    client.diagnostics$.next(issue("direct-invite-receive", "hidden"));
    expect(html()).toContain("Retry local cleanup");
    expect(html()).toContain("disk unavailable");
    expect(html()).not.toContain("error 0");
    expect(html()).not.toContain("hidden");
  });

  it("retains fresh failures emitted during successful cleanup and blocks concurrent retries", async () => {
    const client = activate();
    client.diagnostics$.next(issue());
    const pending = Promise.withResolvers<void>();
    client.retryStorageCleanup.mockReturnValue(pending.promise);
    const request = retryConcordCleanup();
    await retryConcordCleanup();
    expect(client.retryStorageCleanup).toHaveBeenCalledTimes(1);
    client.diagnostics$.next(issue("storage-cleanup", "still blocked"));
    pending.resolve();
    await request;
    expect(html()).toContain("still blocked");
    expect(html()).not.toContain("disk unavailable");
    expect(latest.retryingCleanup).toBe(false);
  });

  it("surfaces rejected cleanup, supports retry and leaves unrelated notices intact", async () => {
    const client = activate();
    client.diagnostics$.next(issue("plane-publish"));
    client.diagnostics$.next(issue());
    client.retryStorageCleanup.mockRejectedValueOnce(new Error("retry failed"));
    await retryConcordCleanup();
    expect(html()).toContain("Cleanup retry failed: retry failed");
    await retryConcordCleanup();
    expect(html()).not.toContain("Retry local cleanup");
    expect(html()).toContain("plane-publish");
    dismissConcordDiagnostics();
    expect(html()).toBe("");
  });

  it.each(["resolve", "reject"])("isolates account switches from late cleanup %s", async (outcome) => {
    const old = activate();
    old.diagnostics$.next(issue());
    const pending = Promise.withResolvers<void>();
    old.retryStorageCleanup.mockReturnValue(pending.promise);
    const request = retryConcordCleanup();
    const next = activate("b");
    next.diagnostics$.next(issue("storage-cleanup", "next account"));
    old.diagnostics$.next(issue("material-persist", "old account"));
    if (outcome === "resolve") pending.resolve();
    else pending.reject(new Error("old retry failed"));
    await request;
    expect(html()).toContain("next account");
    expect(html()).not.toContain("old account");
    expect(html()).not.toContain("old retry failed");
    expect(old.diagnostics$.observed).toBe(false);
  });
});

// Keep the shared snapshot subscription for this module's test lifetime only.
afterAll(() => stateSub.unsubscribe());
