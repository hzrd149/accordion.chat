import { Databases, Media } from "@applesauce/concord";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { retireLegacyImageCache } from "../services/concord-media";

export interface ErasureOptions {
  indexedDB?: IDBFactory;
  localStorage?: Storage;
  timeoutMs?: number;
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Storage cleanup is blocked. Close other Accordion tabs and retry.")), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Deletes matching records in shared databases, never another account's records. */
async function removeRecords(
  factory: IDBFactory,
  name: string,
  stores: string[],
  matches: (key: IDBValidKey) => boolean,
  removed?: (key: IDBValidKey) => void,
) {
  const db = await openDatabase(factory, name);
  try {
    const transaction = db.transaction(stores, "readwrite");
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new Error("Account cleanup transaction aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Account cleanup transaction failed"));
    });
    for (const name of stores) {
      const cursor = transaction.objectStore(name).openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        if (matches(row.key)) {
          removed?.(row.key);
          row.delete();
        }
        row.continue();
      };
    }
    await done;
  } finally { db.close(); }
}

function draftAccount(key: IDBValidKey): unknown {
  const encoded = Array.isArray(key) ? key[0] : key;
  if (typeof encoded !== "string") return undefined;
  try { return JSON.parse(encoded)?.[0]; } catch { return undefined; }
}

function removeDatabase(factory: IDBFactory, name: string) {
  return new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Local erasure only. There is deliberately no client, signer, relay, leave,
 * membership update or publish dependency in this operation.
 * Call only after retiring and draining account resources.
 */
export async function eraseAccountData(pubkey: string, options: ErasureOptions = {}): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(pubkey)) throw new Error("Invalid account public key");
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const local = options.localStorage ?? globalThis.localStorage;
  const timeout = options.timeoutMs ?? 8000;
  // Without enumeration, deleting just the currently-open planes could leave
  // private history from previous sessions behind. Fail rather than claim success.
  if (typeof factory.databases !== "function") throw new Error("This browser cannot enumerate account databases for complete cleanup.");
  const names = (await factory.databases()).flatMap(({ name }) => name ? [name] : []);
  const communities = new Set<string>();
  const pendingKeys = new Set<string>();
  const collectCommunities = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if ("community_id" in value && typeof value.community_id === "string") communities.add(value.community_id);
    for (const child of Object.values(value)) collectCommunities(child);
  };
  for (const key of [pubkey, `concord:community-list:${pubkey}`]) {
    const legacy = local.getItem(key);
    if (legacy) {
      try { collectCommunities(JSON.parse(legacy)); } catch { /* A corrupt mirror still gets removed below. */ }
    }
  }
  const rumorNames = names.filter((name) => {
    const prefix = ["concord:rumors:v1", "accordion:dm-rumors:v1"].find((prefix) => name.startsWith(`${prefix}:`));
    if (!prefix) return false;
    try {
      const tuple: unknown = JSON.parse(name.slice(prefix.length + 1));
      if (!Array.isArray(tuple) || tuple.length !== 3 || tuple[0] !== pubkey) return false;
      if (prefix === "concord:rumors:v1" && typeof tuple[1] === "string") communities.add(tuple[1]);
      return true;
    } catch { return false; }
  });

  const steps: Array<() => Promise<unknown>> = [];
  // Use the SDK's public account-wide deletion API in the browser's global IDB.
  // Injected IDB factories let adapter tests exercise precisely the same names.
  if (factory === globalThis.indexedDB) {
    steps.push(
      () => Databases.createIndexedDBDatabaseFactory(pubkey).deleteAll(),
      () => Databases.createIndexedDBDatabaseFactory(pubkey, { prefix: "accordion:dm-rumors:v1" }).deleteAll(),
      () => Media.createIndexedDBMediaStoreFactory(pubkey).deleteAll(),
    );
  } else {
    steps.push(...rumorNames.map((name) => () => removeDatabase(factory, name)));
    steps.push(...names.filter((name) => {
      if (name === `concord:media:v1:registry:${pubkey}`) return true;
      if (!name.startsWith("concord:media:v1:")) return false;
      try {
        const tuple: unknown = JSON.parse(name.slice("concord:media:v1:".length));
        return Array.isArray(tuple) && tuple.length === 4 && tuple[0] === pubkey;
      } catch { return false; }
    }).map((name) => () => removeDatabase(factory, name)));
  }
  // The legacy shared plaintext cache cannot be attributed to an account.
  // It is retired application-wide rather than imported into scoped SDK stores.
  steps.push(() => retireLegacyImageCache());
  if (names.includes(`accordion:dm-index:${pubkey}`)) {
    steps.push(() => removeDatabase(factory, `accordion:dm-index:${pubkey}`));
  }
  if (names.includes("concord:drafts:v1")) {
    steps.push(() => removeRecords(factory, "concord:drafts:v1", ["drafts", "files"], (key) => draftAccount(key) === pubkey));
  }
  if (names.includes("accordion:concord:v1")) {
    steps.push(() => removeRecords(factory, "accordion:concord:v1", ["records"], (key) =>
      typeof key === "string" && (
        key === `${pubkey}:key` || key.startsWith(`${pubkey}:value:`) ||
        key === `dm:${pubkey}:key` || key.startsWith(`dm:${pubkey}:value:`)
      ), (key) => {
        if (typeof key === "string" && key.startsWith(`${pubkey}:value:concord:pending-refounding:`)) {
          pendingKeys.add(key.slice(`${pubkey}:value:`.length).split(":recovered:")[0]);
        }
      }));
  }

  const results = await Promise.allSettled(steps.map((step) => bounded(Promise.resolve().then(step), timeout)));
  // Opaque legacy pending-rotation slots are account/community hashes. Derive
  // only known owned slots, never delete another account's pending recovery.
  for (const cid of communities) {
    pendingKeys.add(`concord:pending-refounding:v1:${bytesToHex(sha256(new TextEncoder().encode(`${pubkey}:${cid}`)))}`);
  }
  try {
    const keys = Array.from({ length: local.length }, (_, index) => local.key(index)).filter((key): key is string => key !== null);
    for (const key of keys) {
      if (key === pubkey || key === `concord:community-list:${pubkey}` || key === `concord:list-fragments:${pubkey}` ||
        key === `accordion:read-state:${pubkey}` || key === `accordion:dm-failed-wraps:${pubkey}` ||
        key.startsWith(`concord:direct-invites:${pubkey}:`) || key.startsWith(`accordion:dm-expiration:${pubkey}:`) ||
        [...pendingKeys].some((pending) => key === pending || key.startsWith(`${pending}:recovered:`))) {
        local.removeItem(key);
      }
    }
  } catch (error) { results.push({ status: "rejected", reason: error }); }
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not erase all local account data. Close other Accordion tabs and retry.");
}
