// Persist decoded Concord rumors to IndexedDB (via nostr-idb) so a community's
// chat / control / guestbook history survives a reload independent of relay
// behaviour — the same write-through cache pattern src/nostr.ts uses for public
// events, but applied to the package's per-plane RumorStores.
//
// Why a RumorStore + cache and not an AsyncEventStore: the applesauce-concord
// `storeFactory` seam is typed to return a *synchronous* `RumorStore`, and every
// ConcordCommunity fold model (control, guestbook, the chat fold) reads its store
// synchronously (`store.timeline(...)`, `store.getEvent(...)`). `AsyncEventStore`
// is a different, Promise-returning class fed by an `IAsyncEventDatabase` (only
// the applesauce-sqlite drivers implement it — nostr-idb is not one), so it can't
// satisfy the seam. The correct browser shape is the in-memory RumorStore as the
// working set with nostr-idb behind it.
//
// Rumors are *unsigned* (verified by re-hashing their id via `verifyRumor`, not a
// signature) and are decrypted plaintext, so they must never share the public
// event cache DB. nostr-idb ≥5.1 stores these first-class via its `RumorEvent`
// type (its `validateEvent` requires only NIP-01 fields, not `sig`), so they go
// in and out without the sig-shim casts the old signed-only API forced.
// We give each (community, plane) its own IndexedDB database —
// a rumor carries nothing that identifies its plane, and we can't tag it without
// changing its id, so per-plane databases are the only clean namespacing.

import { RumorStore } from "applesauce-core";
import { isFromCache, markFromCache, type Rumor } from "applesauce-core/helpers";
import {
  addEvents,
  deleteDB,
  deleteEventsByIds,
  getEventsForFilters,
  openDB,
  type NostrIDBDatabase,
} from "nostr-idb";
import type { NostrEvent } from "nostr-tools";

// nostr-idb ≥5.1 is generic over `StoredEvent = NostrEvent | RumorEvent`; a
// `Rumor` (applesauce's unsigned-with-id shape) satisfies `RumorEvent`, so we
// parameterise the store helpers with it and let the rows type as rumors end
// to end — no signed-event casts.
import { bufferTime, filter } from "rxjs";

// Cap cached rumors per plane so a busy channel can't grow the DB without bound.
// Generous — control/guestbook planes are small and never approach it; a channel
// keeps its most-recent slice and refetches older history from relays on demand.
const MAX_RUMORS_PER_PLANE = 2000;
// Batch writes so a burst of incoming rumors is one transaction, not one each.
// Kept short so a message sent and then reloaded within a second still persists —
// the cache is meant to be relay-independent, so we can't lean on a refetch.
const WRITE_BATCH_MS = 1_000;

/** IndexedDB name for a plane's rumor cache. Namespaced so it never collides
 *  with the public-event cache ("nostr-idb") or another plane/community. */
function dbName(communityId: string, planeKey: string): string {
  return `concord-rumors:${communityId}:${planeKey}`;
}

// Every DB name we've opened, grouped by community, so leaving a community can
// delete exactly its plaintext caches (see deleteCommunityRumorCache).
const openedDbs = new Map<string, Set<string>>();

/**
 * A `ConcordStoreFactory` that returns an in-memory {@link RumorStore} hydrated
 * from — and written through to — a per-plane nostr-idb database. Pass to
 * `new ConcordClient({ storeFactory })`.
 */
export function createRumorStoreFactory(): (communityId: string, planeKey: string) => RumorStore {
  return (communityId, planeKey) => {
    const store = new RumorStore();
    const name = dbName(communityId, planeKey);

    let set = openedDbs.get(communityId);
    if (!set) openedDbs.set(communityId, (set = new Set()));
    set.add(name);

    // storeFactory is synchronous, so open the DB in the background and let the
    // store fill in as rows load — exactly like src/nostr.ts's nostr-idb start.
    const dbReady: Promise<NostrIDBDatabase | null> = openDB(name).catch((err) => {
      console.warn(`[concord] rumor cache: openDB(${name}) failed; plane stays in-memory`, err);
      return null;
    });

    // Hydrate: load every cached rumor (an empty filter throws in nostr-idb, so
    // `{ since: 0 }` matches all) and add it, marked from-cache so the persist
    // subscription below doesn't immediately write it straight back.
    void dbReady.then(async (db) => {
      if (!db) return;
      try {
        const cached = await getEventsForFilters<Rumor>(db, [{ since: 0 }]);
        for (const event of cached) {
          markFromCache(event as unknown as NostrEvent);
          store.add(event);
        }
      } catch (err) {
        console.warn(`[concord] rumor cache: hydrate(${name}) failed`, err);
      }
    });

    // Persist newly-arrived rumors (skip the ones we just hydrated). Subscribed
    // synchronously so nothing added during the open is missed; the handler waits
    // on dbReady. nostr-idb stores rumors by id without a signature check, so the
    // sig-less rumors persist as-is.
    store.insert$
      .pipe(
        filter((rumor) => !isFromCache(rumor as unknown as NostrEvent)),
        bufferTime(WRITE_BATCH_MS),
        filter((batch) => batch.length > 0),
      )
      .subscribe(async (batch) => {
        const db = await dbReady;
        if (!db) return;
        try {
          await addEvents<Rumor>(db, batch);
          await enforceCap(db);
        } catch (err) {
          console.warn(`[concord] rumor cache: write(${name}) failed`, err);
        }
      });

    // Mirror removals — a kind-5 delete rumor drops its target from the store, so
    // drop it from the cache too (otherwise a reload would resurrect it).
    store.remove$.subscribe(async (rumor) => {
      const db = await dbReady;
      if (!db) return;
      await deleteEventsByIds(db, [rumor.id]).catch(() => {});
    });

    return store;
  };
}

/** Evict the oldest rumors beyond {@link MAX_RUMORS_PER_PLANE}. Results come back
 *  newest-first, so everything past the cap is the oldest slice. */
async function enforceCap(db: NostrIDBDatabase): Promise<void> {
  const all = await getEventsForFilters(db, [{ since: 0 }]);
  if (all.length <= MAX_RUMORS_PER_PLANE) return;
  const overflow = all.slice(MAX_RUMORS_PER_PLANE).map((e) => e.id);
  await deleteEventsByIds(db, overflow);
}

/**
 * Delete every plaintext rumor cache for a community — call this when the user
 * leaves it, so decrypted history doesn't linger on disk after they're removed.
 */
export async function deleteCommunityRumorCache(communityId: string): Promise<void> {
  const set = openedDbs.get(communityId);
  // Include the deterministic names even if this session never opened them (a
  // prior session may have), so a leave always clears the on-disk caches.
  const names = new Set(set);
  openedDbs.delete(communityId);
  await Promise.allSettled([...names].map((name) => deleteDB(name)));
}
