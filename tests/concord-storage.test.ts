import { IDBFactory, IDBDatabase, IDBObjectStore } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createConcordStorage } from "../src/lib/concord-storage";

const opened: ReturnType<typeof createConcordStorage>[] = [];
function legacyStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: (key: string) => values.get(key) ?? null, removeItem: (key: string) => { values.delete(key); } };
}
function storage(pubkey: string, indexedDB: IDBFactory, legacy = legacyStorage()) {
  const value = createConcordStorage(pubkey, { indexedDB, crypto: globalThis.crypto, legacy });
  opened.push(value);
  return value;
}
async function record(indexedDB: IDBFactory, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open("accordion:concord:v1", 1);
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const read = db.transaction("records").objectStore("records").get(key);
      read.onsuccess = () => { db.close(); resolve(read.result); };
      read.onerror = () => { db.close(); reject(read.error); };
    };
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(opened.splice(0).map((value) => value.close()));
});

describe("durable Concord account storage", () => {
  it("roundtrips complete key material while storing ciphertext and a non-extractable device key", async () => {
    const db = new IDBFactory();
    const value = storage("alice", db);
    const history = JSON.stringify({
      entries: [{ community: "community-id", epoch: 12, control_key: "current-member-secret", staff_key: "current-staff-secret",
        previous_control_keys: [{ epoch: 11, key: "old-member-secret" }],
        previous_staff_keys: [{ epoch: 10, key: "old-staff-secret" }],
        channels: { private: { key: "channel-secret", history: [{ epoch: 3, key: "old-channel-secret" }] } } }],
      left: [{ community: "left-community", timestamp: 44 }],
    });
    await value.setItem("alice", history);
    await value.close();
    expect(await storage("alice", db).getItem("alice")).toBe(history);
    const encrypted = await record(db, "alice:value:alice") as { version: number; data: ArrayBuffer; iv: Uint8Array };
    expect(encrypted.version).toBe(1);
    expect(encrypted.iv.byteLength).toBe(12);
    expect(new TextDecoder().decode(encrypted.data)).not.toContain("secret");
    expect(new TextDecoder().decode(encrypted.data)).not.toContain("community-id");
    const key = await record(db, "alice:key") as CryptoKey;
    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", key)).rejects.toThrow();
  });

  it("uses a single winning key when two tabs initialize the account concurrently", async () => {
    const db = new IDBFactory();
    const firstTab = storage("alice", db);
    const secondTab = storage("alice", db);
    await Promise.all([firstTab.setItem("first", "first secret"), secondTab.setItem("second", "second secret")]);
    await Promise.all([firstTab.close(), secondTab.close()]);
    const reload = storage("alice", db);
    expect(await reload.getItem("first")).toBe("first secret");
    expect(await reload.getItem("second")).toBe("second secret");
  });

  it("isolates identical SDK keys across accounts and migrates only the owning account's legacy records", async () => {
    const db = new IDBFactory();
    const legacy = legacyStorage({ alice: "legacy membership", "concord:direct-invites:alice:cursor": "77" });
    const alice = storage("alice", db, legacy);
    const bob = storage("bob", db, legacy);
    expect(await bob.getItem("alice")).toBeNull();
    expect(await bob.getItem("concord:direct-invites:alice:cursor")).toBeNull();
    expect(legacy.getItem("alice")).toBe("legacy membership");
    expect(await alice.getItem("alice")).toBe("legacy membership");
    expect(await alice.getItem("concord:direct-invites:alice:cursor")).toBe("77");
    expect(legacy.getItem("alice")).toBeNull();
    await alice.setItem("shared-key", "alice value");
    await bob.setItem("shared-key", "bob value");
    expect(await alice.getItem("shared-key")).toBe("alice value");
    expect(await bob.getItem("shared-key")).toBe("bob value");
    await alice.removeItem("shared-key");
    expect(await alice.getItem("shared-key")).toBeNull();
    expect(await bob.getItem("shared-key")).toBe("bob value");
  });

  it("keeps legacy data recoverable after encryption failure, propagates failure, and retries", async () => {
    const db = new IDBFactory();
    const legacy = legacyStorage({ alice: "only copy of historical keys" });
    const value = storage("alice", db, legacy);
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValueOnce(new Error("device unavailable"));
    await expect(value.getItem("alice")).rejects.toThrow("device unavailable");
    expect(legacy.getItem("alice")).toBe("only copy of historical keys");
    expect(await record(db, "alice:value:alice")).toBeUndefined();
    expect(await value.getItem("alice")).toBe("only copy of historical keys");
    expect(legacy.getItem("alice")).toBeNull();
  });

  it("retries failed database open and key generation without poisoning the operation lane", async () => {
    const db = new IDBFactory();
    const value = storage("alice", db);
    vi.spyOn(db, "open").mockImplementationOnce(() => { throw new Error("temporary database failure"); });
    await expect(value.getItem("new-key")).rejects.toThrow("temporary database failure");
    expect(await value.getItem("new-key")).toBeNull();
    vi.spyOn(crypto.subtle, "generateKey").mockRejectedValueOnce(new Error("temporary crypto failure"));
    await expect(value.setItem("new-key", "saved")).rejects.toThrow("temporary crypto failure");
    await value.setItem("new-key", "saved");
    expect(await value.getItem("new-key")).toBe("saved");
  });

  it("migrates only requested pending rotation/recovery slots and leaves unrelated legacy slots intact", async () => {
    const db = new IDBFactory();
    const pending = `concord:pending-refounding:v1:${"a".repeat(64)}`;
    const recovered = `${pending}:recovered:${"b".repeat(64)}`;
    const unrelated = `concord:pending-refounding:v1:${"c".repeat(64)}`;
    const epochRecovery = `${pending}:recovered:epoch-12`;
    const legacy = legacyStorage({ [pending]: "rotation material", [recovered]: "recovery evidence", [unrelated]: "another community", [epochRecovery]: "epoch fallback evidence" });
    const value = storage("alice", db, legacy);
    expect(await value.getItem(pending)).toBe("rotation material");
    expect(await value.getItem(recovered)).toBe("recovery evidence");
    expect(await value.getItem(epochRecovery)).toBe("epoch fallback evidence");
    expect(legacy.getItem(pending)).toBeNull();
    expect(legacy.getItem(recovered)).toBeNull();
    expect(legacy.getItem(unrelated)).toBe("another community");
    expect(await record(db, `alice:value:${unrelated}`)).toBeUndefined();
  });

  it("keeps legacy data after a failed commit and retries the durable write", async () => {
    const db = new IDBFactory();
    const legacy = legacyStorage({ alice: "historical material" });
    const value = storage("alice", db, legacy);
    await value.setItem("initialize-key", "ok");
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(function (...args) {
      const pending = originalPut.apply(this, args);
      this.transaction.abort();
      return pending;
    });
    await expect(value.getItem("alice")).rejects.toThrow();
    expect(legacy.getItem("alice")).toBe("historical material");
    expect(await value.getItem("alice")).toBe("historical material");
  });

  it("closes a blocked open that succeeds after the caller has already rejected, then retries", async () => {
    const db = new IDBFactory();
    const originalOpen = db.open.bind(db);
    const closes = vi.spyOn(IDBDatabase.prototype, "close");
    vi.spyOn(db, "open").mockImplementationOnce((...args) => {
      const pending = originalOpen(...args);
      queueMicrotask(() => pending.onblocked?.call(pending, new Event("blocked") as IDBVersionChangeEvent));
      return pending;
    });
    const value = storage("alice", db);
    await expect(value.getItem("missing")).rejects.toThrow("Close other Accordion tabs");
    await vi.waitFor(() => expect(closes).toHaveBeenCalled());
    expect(await value.getItem("missing")).toBeNull();
  });

  it("flushes accepted writes on close and permits deferred compensating SDK writes afterward", async () => {
    const db = new IDBFactory();
    const value = storage("alice", db);
    const saving = value.setItem("membership", "before dispose");
    await value.close();
    await saving;
    expect(await storage("alice", db).getItem("membership")).toBe("before dispose");
    await value.setItem("membership", "compensated rotation");
    await value.close();
    expect(await storage("alice", db).getItem("membership")).toBe("compensated rotation");
  });
});
