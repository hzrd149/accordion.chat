import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConcordClient, Databases, Drafts, Media } from "@applesauce/concord";
import { NostrConnectSigner, PrivateKeySigner } from "applesauce-signers";
import { NostrConnectAccount, PrivateKeyAccount } from "applesauce-accounts/accounts";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { eraseAccountData } from "../src/helpers/account-erasure";
import { accountStorageLease, finishAccountErasure, registerAccountResource, retireAccountResources } from "../src/services/account-lifecycle";
import { createConcordStorage } from "../src/services/concord-storage";
import { openMessageStorage } from "../src/messages/storage";

vi.mock("../src/nostr", async () => {
  const { AccountManager } = await import("applesauce-accounts");
  const { BehaviorSubject } = await import("rxjs");
  const { EventStore } = await import("applesauce-core");
  return { accounts: new AccountManager(), accountAwaitingUnlock$: new BehaviorSubject(undefined), eventStore: new EventStore() };
});
import { accounts, accountAwaitingUnlock$ } from "../src/nostr";
import { initializeLogout, logoutAccount, logouts$ } from "../src/services/logout";

const alice = await PrivateKeySigner.fromKey("1".padStart(64, "0")).getPublicKey();
const bob = await PrivateKeySigner.fromKey("2".padStart(64, "0")).getPublicKey();
const closed: Array<() => Promise<unknown>> = [];

function localStorageMock(): Storage {
  const entries = new Map<string, string>();
  return {
    get length() { return entries.size; },
    key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => { entries.set(key, value); },
    removeItem: (key) => { entries.delete(key); },
    clear: () => entries.clear(),
  };
}
function storage(pubkey: string) {
  const value = createConcordStorage(pubkey);
  closed.push(() => value.close());
  return value;
}
function databases(pubkey: string) {
  const value = Databases.createIndexedDBDatabaseFactory(pubkey);
  closed.push(() => value.close());
  return value;
}
function rumor(pubkey: string, content = "private message") {
  return { id: (pubkey === alice ? "a" : "b").repeat(64), pubkey, kind: 9, tags: [], content, created_at: 1 };
}

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("localStorage", localStorageMock());
  finishAccountErasure(alice);
  finishAccountErasure(bob);
  for (const account of [...accounts.accounts]) accounts.removeAccount(account);
  accountAwaitingUnlock$.next(undefined);
  logouts$.next([]);
});
afterEach(async () => {
  await Promise.allSettled(closed.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  finishAccountErasure(alice);
  finishAccountErasure(bob);
});

describe("local account erasure", () => {
  it("erases every owned community plane, including closed private history, but not another account", async () => {
    const first = databases(alice);
    const other = databases(bob);
    for (const plane of ["control", "channels", "channel:private", "channel:old-private", "guestbook@1", "rekey"]) {
      await first("community", plane).add(rumor(alice));
    }
    await other("community", "channel:private").add(rumor(bob));
    await first.close();
    await eraseAccountData(alice);
    const names = (await indexedDB.databases()).map(({ name }) => name);
    expect(names.some((name) => name?.includes(alice))).toBe(false);
    expect(await other("community", "channel:private").getEvent(rumor(bob).id)).toEqual(rumor(bob));
  });

  it("removes only this account's shared drafts, files, encrypted material and device keys", async () => {
    const draftStore = Drafts.createIndexedDBDraftStore();
    const address = { account: alice, communityId: "community", channelId: "private" };
    await draftStore.set(address, { text: "secret draft", files: [new File(["secret bytes"], "secret.txt")] });
    await draftStore.set({ ...address, account: bob }, { text: "other draft", files: [new File(["other bytes"], "other.txt")] });
    await draftStore.close();
    const aliceStorage = storage(alice);
    const bobStorage = storage(bob);
    await aliceStorage.setItem(alice, "private channel keys");
    await bobStorage.setItem(bob, "other keys");
    await Promise.all([aliceStorage.close(), bobStorage.close()]);
    await eraseAccountData(alice);
    const reloadedDrafts = Drafts.createIndexedDBDraftStore();
    closed.push(() => reloadedDrafts.close());
    expect(await reloadedDrafts.get(address)).toBeUndefined();
    const other = await reloadedDrafts.get({ ...address, account: bob });
    expect(other?.text).toBe("other draft");
    expect(await other!.files![0].text()).toBe("other bytes");
    expect(await storage(alice).getItem(alice)).toBeNull();
    expect(await storage(bob).getItem(bob)).toBe("other keys");
    const opening = indexedDB.open("accordion:concord:v1");
    const db = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result); });
    const reading = db.transaction("records").objectStore("records").getAllKeys();
    const keys = await new Promise<IDBValidKey[]>((resolve) => { reading.onsuccess = () => resolve(reading.result); });
    db.close();
    expect(keys).not.toContain(`${alice}:key`);
    expect(keys).toContain(`${bob}:key`);
  });

  it("deletes DM history, indexes and encrypted caches, even when messaging is disabled later", async () => {
    const dm = await openMessageStorage(alice);
    const other = await openMessageStorage(bob);
    await dm.draftStorage.setItem("test", "private draft");
    await other.draftStorage.setItem("test", "other private draft");
    await dm.close();
    await other.close();
    await eraseAccountData(alice);
    const names = (await indexedDB.databases()).map(({ name }) => name);
    expect(names).not.toContain(`accordion:dm-index:${alice}`);
    expect(names).toContain(`accordion:dm-index:${bob}`);
    expect(await storage(`dm:${alice}`).getItem("drafts:test")).toBeNull();
    expect(await storage(`dm:${bob}`).getItem("drafts:test")).toBe("other private draft");
  });

  it("erases private-channel media and its registry only for the signed-out account", async () => {
    const own = Media.createIndexedDBMediaStoreFactory(alice);
    const other = Media.createIndexedDBMediaStoreFactory(bob);
    closed.push(() => own.close(), () => other.close());
    const hash = "a".repeat(64);
    const privatePlane = { kind: "private-channel" as const, channelId: "private" };
    await own("community", privatePlane).put(hash, new Uint8Array([1, 2, 3]));
    await other("community", privatePlane).put(hash, new Uint8Array([4, 5, 6]));
    await own.close();
    await eraseAccountData(alice);
    expect((await indexedDB.databases()).some(({ name }) => name?.includes(alice))).toBe(false);
    expect(await other("community", privatePlane).get(hash)).toEqual(new Uint8Array([4, 5, 6]));
  });

  it("cleans account-owned legacy recovery and read state, leaving global preferences and other accounts alone", async () => {
    await databases(alice)("community", "channel:private").add(rumor(alice));
    const hash = bytesToHex(sha256(new TextEncoder().encode(`${alice}:community`)));
    const pending = `concord:pending-refounding:v1:${hash}`;
    const own = [alice, `concord:community-list:${alice}`, `concord:list-fragments:${alice}`,
      `concord:direct-invites:${alice}:dismissed`, `accordion:read-state:${alice}`,
      `accordion:dm-expiration:${alice}:peer`, pending, `${pending}:recovered:epoch-1`];
    const retained = [bob, `accordion:read-state:${bob}`, "accordion:appearance", "concord:pending-refounding:v1:unrelated"];
    for (const key of [...own, ...retained]) localStorage.setItem(key, "test");
    await closed[0]();
    await eraseAccountData(alice);
    for (const key of own) expect(localStorage.getItem(key), key).toBeNull();
    for (const key of retained) expect(localStorage.getItem(key), key).toBe("test");
  });

  it("reports blocked database deletion instead of hanging or claiming cleanup succeeded", async () => {
    const name = `concord:rumors:v1:${JSON.stringify([alice, "community", "channel:private"])}`;
    const opening = indexedDB.open(name, 1);
    const blocker = await new Promise<IDBDatabase>((resolve) => { opening.onsuccess = () => resolve(opening.result); });
    await expect(eraseAccountData(alice, { timeoutMs: 20 })).rejects.toThrow("Could not erase all");
    blocker.close();
    await eraseAccountData(alice);
    expect((await indexedDB.databases()).some(({ name: candidate }) => candidate === name)).toBe(false);
  });

  it("refuses to claim complete erasure if database enumeration is unavailable", async () => {
    vi.spyOn(indexedDB, "databases").mockImplementation(() => { throw new Error("unavailable"); });
    await expect(eraseAccountData(alice)).rejects.toThrow();
  });
});

describe("logout lifetime barrier", () => {
  it("drains already accepted writes and rejects all late writes, including from normally closed adapters", async () => {
    const before = storage(alice);
    await before.setItem("before", "secret");
    await before.close();
    // A deferred SDK compensation can reopen a normally closed adapter.
    const accepted = before.setItem("compensation", "secret");
    await retireAccountResources(alice);
    await accepted;
    await expect(before.setItem("late", "must not survive")).rejects.toThrow("retired");
    await eraseAccountData(alice);
    finishAccountErasure(alice);
    await expect(before.setItem("later", "must not survive")).rejects.toThrow("retired");
    expect(await storage(alice).getItem("before")).toBeNull();
    expect(await storage(alice).getItem("compensation")).toBeNull();
  });

  it("retires pending DM storage opening before it can start an inbox", async () => {
    const pending = openMessageStorage(alice);
    const stopped = retireAccountResources(alice);
    await expect(pending).rejects.toThrow("retired");
    await stopped;
    await eraseAccountData(alice);
    expect((await indexedDB.databases()).some(({ name }) => name?.includes(alice))).toBe(false);
  });

  it("preserves ordinary close/reopen behavior for reloads and account switching", async () => {
    const before = storage(alice);
    await before.setItem("keys", "membership");
    await before.close();
    expect(await before.getItem("keys")).toBe("membership");
    await before.setItem("keys", "compensated membership");
    await before.close();
    expect(await storage(alice).getItem("keys")).toBe("compensated membership");
  });
});

describe("sign-out orchestration", () => {
  it("only disposes local resources; never leaves communities, revokes grants, or publishes a community list", async () => {
    const account = PrivateKeyAccount.fromKey("1".padStart(64, "0"));
    const other = PrivateKeyAccount.fromKey("2".padStart(64, "0"));
    accounts.addAccount(account);
    accounts.addAccount(other);
    accounts.setActive(account);
    const leave = vi.spyOn(ConcordClient.prototype, "leave");
    const saveList = vi.spyOn(ConcordClient.prototype, "saveCommunityList");
    const dispose = vi.fn(async () => {});
    registerAccountResource(alice, dispose);
    const privateStorage = storage(alice);
    await privateStorage.setItem(alice, "membership");
    const first = logoutAccount(alice);
    expect(logoutAccount(alice)).toBe(first);
    expect(await first).toBe(true);
    expect(dispose).toHaveBeenCalledOnce();
    expect(leave).not.toHaveBeenCalled();
    expect(saveList).not.toHaveBeenCalled();
    expect(accounts.active).toBeUndefined();
    expect(accounts.accounts).toEqual([other]);
    expect(account.signer.key.every((byte) => byte === 0)).toBe(true);
    expect(localStorage.getItem("concord:accounts")).not.toContain(alice);
    expect(localStorage.getItem(`accordion:logout:${alice}`)).toBeNull();
    expect(logouts$.value).toEqual([]);
  });

  it("closes the local remote-signer connection without sending a remote logout or other request", async () => {
    const signer = new NostrConnectSigner({ relays: ["wss://test.example"], subscriptionMethod: () => { throw new Error("no network"); }, publishMethod: () => { throw new Error("no network"); } });
    const close = vi.spyOn(signer, "close").mockResolvedValue();
    const logout = vi.spyOn(signer, "logout");
    accounts.addAccount(new NostrConnectAccount(alice, signer));
    expect(await logoutAccount(alice)).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
  });

  it("retains a durable retry marker and a visible error after partial failure", async () => {
    const account = PrivateKeyAccount.fromKey("1".padStart(64, "0"));
    accounts.addAccount(account);
    registerAccountResource(alice, async () => { throw new Error("close failed"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await logoutAccount(alice)).toBe(false);
    expect(accounts.accounts).toEqual([]);
    expect(localStorage.getItem(`accordion:logout:${alice}`)).toBeTruthy();
    expect(logouts$.value[0].status).toBe("error");
    expect(() => accountStorageLease(alice)()).toThrow("retired");
    expect(await logoutAccount(alice)).toBe(true);
    expect(logouts$.value).toEqual([]);
  });

  it("resumes an interrupted logout on startup without signing the account back in", async () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    localStorage.setItem(`accordion:logout:${alice}`, "interrupted");
    const stop = initializeLogout();
    await vi.waitFor(() => expect(localStorage.getItem(`accordion:logout:${alice}`)).toBeNull());
    expect(logouts$.value).toEqual([]);
    stop();
  });
});
