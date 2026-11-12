// Decoded, unsigned plaintext must remain separate from the public event cache.
// Keep the existing names: upgrading must not discard already held history/keys.
import { RumorStore } from "applesauce-core";
import { EventStoreSymbol, isEphemeralKind, markFromCache, type Rumor } from "applesauce-core/helpers";
import { addEvents, deleteDB, deleteEventsByIds, getEventsForFilters, openDB } from "nostr-idb";
import type { NostrEvent } from "nostr-tools";

const DB_PREFIX = "concord-rumors:";
const WRITE_BATCH_MS = 1_000;

interface PlaneCache {
  name: string;
  dispose(): Promise<void>;
}
const openedPlanes = new Map<string, Set<PlaneCache>>();
// A new account/client may open the same plane before the previous asynchronous
// shutdown finishes. Gate its open behind every earlier close/delete operation.
const closingDatabases = new Map<string, Promise<void>>();
const purgingCommunities = new Map<string, Promise<void>>();

export interface RumorStoreFactory {
  (communityId: string, planeKey: string): RumorStore;
  /** Flush pending writes and release all stores/DB handles owned by this client. */
  dispose(): Promise<void>;
}

/** Restore a retained channel delete without feeding the upstream destructive
 * delete manager. Concord uses the same public database/memory/insert$ seam for
 * authenticated live deletes. Hash verification still applies to cached rows.
 */
function restoreRumor(store: RumorStore, rumor: Rumor): void {
  if (rumor.kind !== 5) {
    store.add(rumor);
    return;
  }
  if (!store.verifyEvent?.(rumor) || store.hasEvent(rumor.id)) return;
  const inserted = store.database.add(rumor);
  const canonical = store.memory.add(inserted);
  Object.defineProperty(canonical, EventStoreSymbol, { value: store, configurable: true, writable: true });
  store.insert$.next(canonical);
}

/** Synchronous Concord storeFactory with serialized, asynchronous write-through.
 *
 * Retention is deliberately conservative: control, rekey, guestbook and dissolved
 * planes are protocol evidence, and channel originals/deletes/edits/reactions are
 * inputs to a reversible moderation projection. An age/count cap cannot safely
 * distinguish dispensable rows. Preserve all non-ephemeral inputs until Concord
 * supplies a verified compaction boundary; display limits belong in the UI.
 * Existing caches are read in place. Originals pruned by the old cache cannot be
 * recovered locally; normal verified relay synchronization can refill them.
 */
export function createRumorStoreFactory(): RumorStoreFactory {
  const owned = new Set<PlaneCache>();
  let factoryDisposed = false;
  const factory: RumorStoreFactory = Object.assign((communityId: string, planeKey: string) => {
    if (factoryDisposed) throw new Error("Rumor cache factory is disposed");
    const store = new RumorStore({ keepOldVersions: true });
    const name = `${DB_PREFIX}${communityId}:${planeKey}`;
    let stopped = false;
    const hydrating = new WeakSet<Rumor>();
    let hydrationComplete = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed: Promise<void> | undefined;
    const removedDuringHydration = new Set<string>();
    type Operation = { add: Rumor } | { remove: string };
    let pending: Operation[] = [];
    const ready = Promise.all([closingDatabases.get(name), purgingCommunities.get(communityId)])
      .then(() => openDB(name))
      .catch((err) => {
        console.warn(`[concord] rumor cache: open(${name}) failed; using memory`, err);
        return null;
      });

    // Hydration is the first serialized operation. Live inserts/removals are
    // subscribed immediately and queued behind it; stopping cancels hydration.
    let queue: Promise<void> = ready.then(async (db) => {
      if (!db || stopped) return;
      const cached = await getEventsForFilters<Rumor>(db, [{ since: 0 }]);
      if (stopped) return;
      try {
        for (const rumor of cached) {
          if (removedDuringHydration.has(rumor.id) || isEphemeralKind(rumor.kind)) continue;
          markFromCache(rumor as unknown as NostrEvent);
          hydrating.add(rumor);
          try { restoreRumor(store, rumor); }
          finally { hydrating.delete(rumor); }
        }
      } finally {
        removedDuringHydration.clear();
      }
    }).catch((err) => console.warn(`[concord] rumor cache: hydrate(${name}) failed`, err)).finally(() => {
      hydrationComplete = true;
      removedDuringHydration.clear();
    });

    function flush(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      if (!pending.length) return;
      const batch = pending;
      pending = [];
      queue = queue.then(async () => {
        const db = await ready;
        if (!db) return;
        // Batch adjacent inserts but keep removes in order: otherwise an insert
        // delayed by openDB can resurrect an event removed in the meantime.
        let inserts: Rumor[] = [];
        const writeInserts = async () => {
          if (inserts.length) await addEvents<Rumor>(db, inserts);
          inserts = [];
        };
        for (const operation of batch) {
          if ("add" in operation) inserts.push(operation.add);
          else {
            await writeInserts();
            await deleteEventsByIds(db, [operation.remove]);
          }
        }
        await writeInserts();
      }).catch((err) => console.warn(`[concord] rumor cache: write(${name}) failed`, err));
    }

    const subs = [
      store.insert$.subscribe((rumor) => {
        if (stopped || hydrating.delete(rumor) || isEphemeralKind(rumor.kind)) return;
        removedDuringHydration.delete(rumor.id);
        pending.push({ add: rumor });
        timer ??= setTimeout(flush, WRITE_BATCH_MS);
      }),
      store.remove$.subscribe((rumor) => {
        if (stopped) return;
        if (!hydrationComplete) removedDuringHydration.add(rumor.id);
        pending.push({ remove: rumor.id });
        flush();
      }),
    ];
    const originalDispose = store.dispose.bind(store);
    const plane: PlaneCache = {
      name,
      dispose() {
        if (disposed) return disposed;
        stopped = true;
        for (const sub of subs) sub.unsubscribe();
        flush();
        originalDispose();
        disposed = queue.then(async () => { (await ready)?.close(); });
        closingDatabases.set(name, disposed);
        void disposed.finally(() => {
          if (closingDatabases.get(name) === disposed) closingDatabases.delete(name);
          openedPlanes.get(communityId)?.delete(plane);
          if (!openedPlanes.get(communityId)?.size) openedPlanes.delete(communityId);
          owned.delete(plane);
        });
        return disposed;
      },
    };
    store.dispose = () => { void plane.dispose(); };
    const planes = openedPlanes.get(communityId) ?? new Set<PlaneCache>();
    planes.add(plane);
    openedPlanes.set(communityId, planes);
    owned.add(plane);
    return store;
  }, {
    async dispose() {
      factoryDisposed = true;
      await Promise.all([...owned].map((plane) => plane.dispose()));
    },
  });
  return factory;
}

/** Purge every plaintext plane, including channels unopened in this session.
 * Stop and flush writers, close handles, then delete — IndexedDB otherwise
 * silently blocks deletes. A subsequent open waits for the deletion to finish.
 */
export function deleteCommunityRumorCache(communityId: string): Promise<void> {
  const existing = purgingCommunities.get(communityId);
  if (existing) return existing;
  const deletion = purgeCommunity(communityId).finally(() => {
    if (purgingCommunities.get(communityId) === deletion) purgingCommunities.delete(communityId);
  });
  purgingCommunities.set(communityId, deletion);
  return deletion;
}

async function purgeCommunity(communityId: string): Promise<void> {
  const planes = [...(openedPlanes.get(communityId) ?? [])];
  const names = new Set(planes.map((plane) => plane.name));
  await Promise.all(planes.map((plane) => plane.dispose()));
  const prefix = `${DB_PREFIX}${communityId}:`;
  try {
    for (const db of (await indexedDB.databases?.()) ?? [])
      if (db.name?.startsWith(prefix)) names.add(db.name);
  } catch (err) {
    console.warn("[concord] rumor cache: could not enumerate databases", err);
  }
  await Promise.all([...names].map((name) => {
    const deletion = (closingDatabases.get(name) ?? Promise.resolve()).then(() => deleteDB(name));
    closingDatabases.set(name, deletion);
    return deletion.finally(() => {
      if (closingDatabases.get(name) === deletion) closingDatabases.delete(name);
    });
  }));
}
