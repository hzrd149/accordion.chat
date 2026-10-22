import type { ConcordStorage } from "@applesauce/concord";

const DB_NAME = "accordion:concord:v1";
const STORE = "records";
interface Ciphertext {
  version: 1;
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("Concord storage request failed"));
  });
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("Concord storage transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Concord storage transaction failed"));
  });
}

/** Durable account-scoped material storage. Encryption protects exported storage
 * values; the device key is a non-extractable CryptoKey in the same origin's IDB.
 * Same-origin scripts with access to that key remain trusted. No signer prompts
 * are needed to restore offline memberships or commit a rotation. */
export function createConcordStorage(
  pubkey: string,
  options: { indexedDB?: IDBFactory; crypto?: Crypto; legacy?: Pick<Storage, "getItem" | "removeItem"> } = {},
): ConcordStorage & { close(): Promise<void> } {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const crypto = options.crypto ?? globalThis.crypto;
  const legacy = options.legacy ?? globalThis.localStorage;
  let database: Promise<IDBDatabase> | undefined;
  let keyPromise: Promise<CryptoKey> | undefined;
  let lane: Promise<unknown> = Promise.resolve();
  const prefix = `${pubkey}:value:`;

  function open(): Promise<IDBDatabase> {
    if (!database) {
      database = new Promise<IDBDatabase>((resolve, reject) => {
        const pending = factory.open(DB_NAME, 1);
        let rejected = false;
        pending.onupgradeneeded = () => pending.result.createObjectStore(STORE);
        pending.onerror = () => reject(pending.error ?? new Error("Cannot open Concord storage"));
        pending.onblocked = () => {
          rejected = true;
          reject(new Error("Close other Accordion tabs to upgrade Concord storage"));
        };
        pending.onsuccess = () => {
          const db = pending.result;
          // An IDB open cannot be cancelled after reporting blocked. If the
          // blocker later releases it, close the abandoned successful handle.
          if (rejected) { db.close(); return; }
          db.onversionchange = () => db.close();
          resolve(db);
        };
      }).catch((error) => {
        database = undefined;
        throw error;
      });
    }
    return database;
  }

  async function deviceKey(): Promise<CryptoKey> {
    if (!keyPromise) {
      keyPromise = (async () => {
        const db = await open();
        const candidate = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
        // Resolve the winner inside one read/write transaction, including when
        // two tabs first initialize this account at the same time.
        const transaction = db.transaction(STORE, "readwrite");
        const done = committed(transaction);
        const store = transaction.objectStore(STORE);
        const existing = await request(store.get(`${pubkey}:key`)) as CryptoKey | undefined;
        if (!existing) store.put(candidate, `${pubkey}:key`);
        await done;
        return existing ?? candidate;
      })().catch((error) => {
        keyPromise = undefined;
        throw error;
      });
    }
    return keyPromise;
  }

  async function read(key: string): Promise<Ciphertext | undefined> {
    const db = await open();
    return request(db.transaction(STORE).objectStore(STORE).get(prefix + key));
  }

  async function write(key: string, value: string): Promise<void> {
    const secret = await deviceKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(prefix + key) },
      secret,
      new TextEncoder().encode(value),
    );
    const db = await open();
    const transaction = db.transaction(STORE, "readwrite");
    const done = committed(transaction);
    transaction.objectStore(STORE).put({ version: 1, iv, data } satisfies Ciphertext, prefix + key);
    await done;
  }

  function ownsLegacyKey(key: string): boolean {
    // Pending recovery keys are account/community hashes. Only migrate the
    // exact opaque slot requested by the owning SDK; never enumerate them.
    return key === pubkey || key.startsWith(`concord:direct-invites:${pubkey}:`) ||
      /^concord:pending-refounding:v1:[0-9a-f]{64}(?::recovered:(?:[0-9a-f]{64}|epoch-[0-9]+))?$/.test(key);
  }

  function enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = lane.then(work);
    const tail = result.catch(() => undefined);
    lane = tail;
    void tail.then(async () => {
      if (lane !== tail) return;
      const current = database;
      database = undefined;
      (await current)?.close();
    });
    return result;
  }

  return {
    getItem: (key) => enqueue(async () => {
      const stored = await read(key);
      if (stored) {
        if (stored.version !== 1) throw new Error("Unsupported Concord storage version");
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: stored.iv, additionalData: new TextEncoder().encode(prefix + key) },
          await deviceKey(),
          stored.data,
        );
        return new TextDecoder().decode(plain);
      }
      // Migrate the existing SDK mirror/cursors only after the new encrypted
      // record has committed. Failed migration leaves the old copy recoverable.
      const previous = ownsLegacyKey(key) ? legacy?.getItem(key) : null;
      if (previous !== null && previous !== undefined) {
        await write(key, previous);
        legacy?.removeItem(key);
        return previous;
      }
      return null;
    }),
    setItem: (key, value) => enqueue(async () => {
      await write(key, value);
      if (ownsLegacyKey(key)) legacy?.removeItem(key);
    }),
    removeItem: (key) => enqueue(async () => {
      const db = await open();
      const transaction = db.transaction(STORE, "readwrite");
      const done = committed(transaction);
      transaction.objectStore(STORE).delete(prefix + key);
      await done;
      if (ownsLegacyKey(key)) legacy?.removeItem(key);
    }),
    // Disposal can be followed by SDK compensating writes after an async save.
    // Each idle lane closes its handle; later writes may reopen it safely.
    async close() {
      let pending;
      do {
        pending = lane;
        await pending;
      } while (pending !== lane);
      const current = database;
      database = undefined;
      (await current)?.close();
    },
  };
}
