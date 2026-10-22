import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getEventHash, type Rumor } from "applesauce-core/helpers";
import { addEvents, getEventsForFilters, openDB } from "nostr-idb";
import { createRumorStoreFactory, deleteCommunityRumorCache } from "../src/lib/rumor-cache";

let sequence = 0;
const communities: string[] = [];
const factories: ReturnType<typeof createRumorStoreFactory>[] = [];
function community() {
  const id = `cache-test-${++sequence}`;
  communities.push(id);
  return id;
}
function factory() {
  const value = createRumorStoreFactory();
  factories.push(value);
  return value;
}
function rumor(kind: number, content: string, tags: string[][] = [], created_at = sequence): Rumor {
  const template = { kind, content, tags, created_at, pubkey: "a".repeat(64) };
  return { ...template, id: getEventHash(template) };
}
async function read(cid: string, plane = "channel:general") {
  const db = await openDB(`concord-rumors:${cid}:${plane}`);
  try { return await getEventsForFilters<Rumor>(db, [{ since: 0 }]); }
  finally { db.close(); }
}
afterEach(async () => {
  await Promise.all(factories.splice(0).map((value) => value.dispose()));
  await Promise.all(communities.splice(0).map(deleteCommunityRumorCache));
});

describe("Concord rumor cache adapter", () => {
  it("restores originals and retained deletes together without destructive upstream delete handling", async () => {
    const cid = community();
    const message = rumor(9, "original");
    const deletion = rumor(5, "", [["e", message.id]], sequence + 1);
    const db = await openDB(`concord-rumors:${cid}:channel:general`);
    await addEvents(db, [message, deletion]);
    db.close();
    const store = factory()(cid, "channel:general");
    await vi.waitFor(() => expect(store.getEvent(deletion.id)).toBeDefined());
    expect(store.getEvent(message.id)?.content).toBe("original");
    // A later original is still admitted: no stale DeleteManager tombstone.
    store.remove(message.id);
    store.add(message);
    expect(store.getEvent(message.id)).toBeDefined();
  });

  it("verifies retained cached deletes rather than trusting IndexedDB contents", async () => {
    const cid = community();
    const valid = rumor(9, "marker");
    const forged = { ...rumor(5, ""), id: "b".repeat(64) };
    const db = await openDB(`concord-rumors:${cid}:channel:general`);
    await addEvents(db, [valid, forged]);
    db.close();
    const store = factory()(cid, "channel:general");
    await vi.waitFor(() => expect(store.getEvent(valid.id)).toBeDefined());
    expect(store.getEvent(forged.id)).toBeUndefined();
  });

  it("flushes pending writes on disposal, excludes presence, and serializes removals after inserts", async () => {
    const cid = community();
    const value = factory();
    const store = value(cid, "channel:general");
    const removed = rumor(9, "removed");
    const retained = rumor(9, "retained");
    store.add(removed);
    store.remove(removed.id);
    store.add(retained);
    store.add(rumor(23313, "presence"));
    await value.dispose();
    expect((await read(cid)).map((event) => event.id)).toEqual([retained.id]);
    expect(() => value(cid, "control")).toThrow("disposed");
  });

  it("serializes a fresh client opening the same plane behind old pending writes and close", async () => {
    const cid = community();
    const first = factory();
    const message = rumor(9, "during switch");
    first(cid, "channel:general").add(message);
    const closing = first.dispose();
    const secondStore = factory()(cid, "channel:general");
    await closing;
    await vi.waitFor(() => expect(secondStore.getEvent(message.id)).toBeDefined());
  });

  it("does not resurrect a cached row removed while hydration is still opening", async () => {
    const cid = community();
    const message = rumor(9, "removed during hydrate");
    const marker = rumor(9, "hydrate marker");
    const db = await openDB(`concord-rumors:${cid}:channel:general`);
    await addEvents(db, [message, marker]);
    db.close();
    const value = factory();
    const store = value(cid, "channel:general");
    store.add(message);
    store.remove(message.id);
    await vi.waitFor(() => expect(store.getEvent(marker.id)).toBeDefined());
    expect(store.getEvent(message.id)).toBeUndefined();
    await value.dispose();
    expect((await read(cid)).map((event) => event.id)).toEqual([marker.id]);
  });

  it("gates a concurrent reopen behind community plaintext purge", async () => {
    const cid = community();
    const first = factory();
    const original = rumor(9, "old account copy");
    first(cid, "channel:general").add(original);
    const deleting = deleteCommunityRumorCache(cid);
    const second = factory();
    const reopened = second(cid, "channel:general");
    const next = rumor(9, "new session");
    reopened.add(next);
    await deleting;
    await second.dispose();
    expect((await read(cid)).map((event) => event.id)).toEqual([next.id]);
  });

  it("does not restore cached rows after immediate disposal", async () => {
    const cid = community();
    const db = await openDB(`concord-rumors:${cid}:channel:general`);
    await addEvents(db, [rumor(9, "cached")]);
    db.close();
    const value = factory();
    const store = value(cid, "channel:general");
    let inserts = 0;
    store.insert$.subscribe(() => { inserts++; });
    await value.dispose();
    expect(inserts).toBe(0);
  });

  it("preserves protocol history beyond the former blanket 2000-row cap", async () => {
    const cid = community();
    const value = factory();
    const store = value(cid, "control");
    for (let index = 0; index < 2005; index++) store.add(rumor(1, `authority ${index}`, [], index + 1));
    await value.dispose();
    expect(await read(cid, "control")).toHaveLength(2005);
  });

  it("purges both active and previously opened planes and prevents disposed writers recreating them", async () => {
    const cid = community();
    const db = await openDB(`concord-rumors:${cid}:channel:unopened`);
    await addEvents(db, [rumor(9, "old")]);
    db.close();
    const store = factory()(cid, "channel:general");
    store.add(rumor(9, "pending"));
    await deleteCommunityRumorCache(cid);
    store.add(rumor(9, "after leave"));
    expect((await indexedDB.databases()).filter((entry) => entry.name?.startsWith(`concord-rumors:${cid}:`))).toEqual([]);
  });
});
