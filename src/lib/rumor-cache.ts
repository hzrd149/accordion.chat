// Persist decoded Concord rumors to IndexedDB (via nostr-idb) so a community's
// chat / control / guestbook history survives a reload independent of relay
// behaviour — the same write-through cache pattern src/nostr.ts uses for public
// events, but applied to the package's per-plane RumorStores.
//
// Why a RumorStore + write-through and not an AsyncRumorStore: the storeFactory
// seam accepts either (`ConcordRumorStore = RumorStore | AsyncRumorStore`), but
// an AsyncRumorStore needs an `IAsyncEventDatabase` — a 12-method interface
// (replaceable lookups, history, filter matching) that only the applesauce-sqlite
// drivers implement; nostr-idb is not one, so it would mean hand-writing that
// adapter. It would also buy little: an async store's reads all return promises,
// while the in-memory RumorStore keeps the working set synchronous for the fold
// models, and reload-survival — the reason to reach for an async store — is what
// the write-through below already delivers. Revisit if a plane's history outgrows
// memory, which is what an async store would actually solve.
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
import { bufferTime, filter, type Subscription } from "rxjs";

// Cap cached rumors per plane so a busy channel can't grow the DB without bound.
// Generous — control/guestbook planes are small and never approach it; a channel
// keeps its most-recent slice and refetches older history from relays on demand.
const MAX_RUMORS_PER_PLANE = 2000;
// Batch writes so a burst of incoming rumors is one transaction, not one each.
// Kept short so a message sent and then reloaded within a second still persists —
// the cache is meant to be relay-independent, so we can't lean on a refetch.
const WRITE_BATCH_MS = 1_000;

const DB_PREFIX = "concord-rumors:";

/** IndexedDB name for a plane's rumor cache. Namespaced so it never collides
 *  with the public-event cache ("nostr-idb") or another plane/community. */
function dbName(communityId: string, planeKey: string): string {
  return `${DB_PREFIX}${communityId}:${planeKey}`;
}

/** A plane's cache, tracked so leaving a community can tear it down. The open
 *  handle and the write-through subscriptions both have to go before the delete
 *  — see {@link deleteCommunityRumorCache}. */
interface PlaneCache {
  name: string;
  ready: Promise<NostrIDBDatabase | null>;
  subs: Subscription[];
}

// Every plane we've opened, grouped by community.
const openedPlanes = new Map<string, PlaneCache[]>();

/**
 * A `ConcordStoreFactory` that returns an in-memory {@link RumorStore} hydrated
 * from — and written through to — a per-plane nostr-idb database. Pass to
 * `new ConcordClient({ storeFactory })`.
 */
export function createRumorStoreFactory(): (communityId: string, planeKey: string) => RumorStore {
  return (communityId, planeKey) => {
    const store = new RumorStore();
    const name = dbName(communityId, planeKey);

    // storeFactory is synchronous, so open the DB in the background and let the
    // store fill in as rows load — exactly like src/nostr.ts's nostr-idb start.
    const dbReady: Promise<NostrIDBDatabase | null> = openDB(name).catch((err) => {
      console.warn(`[concord] rumor cache: openDB(${name}) failed; plane stays in-memory`, err);
      return null;
    });

    const plane: PlaneCache = { name, ready: dbReady, subs: [] };
    const planes = openedPlanes.get(communityId);
    if (planes) planes.push(plane);
    else openedPlanes.set(communityId, [plane]);

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
    plane.subs.push(
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
        }),
    );

    // Mirror removals — a kind-5 delete rumor drops its target from the store, so
    // drop it from the cache too (otherwise a reload would resurrect it).
    plane.subs.push(
      store.remove$.subscribe(async (rumor) => {
        const db = await dbReady;
        if (!db) return;
        await deleteEventsByIds(db, [rumor.id]).catch(() => {});
      }),
    );

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
 *
 * Two things make this less obvious than it looks:
 *
 * IndexedDB will not delete a database while a connection to it is open — the
 * request fires `blocked` and simply waits — so the write-through subscriptions
 * have to be stopped and our handles closed *first*, or the delete hangs and the
 * plaintext stays on disk.
 *
 * The planes we opened are also not the whole story: a `channel:<id>` plane only
 * gets a store when that channel is first read, so a reload followed by a leave
 * would strand the decrypted history of every channel this session never opened.
 * Enumerate the real databases by prefix to catch those, keeping our own names as
 * the fallback for browsers without `indexedDB.databases()`.
 */
export async function deleteCommunityRumorCache(communityId: string): Promise<void> {
  const planes = openedPlanes.get(communityId) ?? [];
  openedPlanes.delete(communityId);
  const names = new Set(planes.map((plane) => plane.name));

  for (const plane of planes) {
    for (const sub of plane.subs) sub.unsubscribe();
    (await plane.ready)?.close();
  }

  const prefix = `${DB_PREFIX}${communityId}:`;
  try {
    for (const db of (await indexedDB.databases?.()) ?? [])
      if (db.name?.startsWith(prefix)) names.add(db.name);
  } catch (err) {
    console.warn("[concord] rumor cache: could not enumerate databases", err);
  }

  await Promise.allSettled([...names].map((name) => deleteDB(name)));
}
