import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventStore } from "applesauce-core";
import { getEventHash, unixNow, type Rumor } from "applesauce-core/helpers";
import { RelayPool } from "applesauce-relay";
import { WrappedMessagesClient, type PreparedWrappedMessage, type WrappedConversationSummary } from "applesauce-extra/messages";
import { Subject } from "rxjs";
import { conversationSummaries, type ConversationSource } from "../src/messages/conversations";
import { pendingPublication, publishConversationDraft } from "../src/messages/publication";
import { openMessageStorage } from "../src/messages/storage";

const self = "a".repeat(64);
const peer = "b".repeat(64);
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function client() {
  const store = new EventStore();
  const client = new WrappedMessagesClient({ pubkey: self, eventStore: store, pool: new RelayPool() });
  cleanups.push(() => { client.dispose(); store.dispose(); });
  return client;
}
function rumor(content: string, created_at = unixNow()): Rumor {
  const template = { kind: 14, content, created_at, pubkey: self, tags: [["p", peer]] };
  return { ...template, id: getEventHash(template) };
}
function prepared(message: Rumor, publish = vi.fn().mockResolvedValue(message)): PreparedWrappedMessage {
  return { message, publications: [], publish };
}

describe("DM publication integration", () => {
  it("retains the same SDK envelopes after partial failure and across conversation lookups", async () => {
    const owner = client();
    const conversation = owner.conversation(peer);
    await conversation.setDraft({ content: "hello" });
    const message = rumor("hello");
    const publish = vi.fn().mockRejectedValueOnce(new Error("sender copy rejected")).mockResolvedValue(message);
    const handle = prepared(message, publish);
    const prepare = vi.spyOn(conversation, "prepareSend").mockResolvedValue(handle);
    await expect(publishConversationDraft(conversation, { content: "hello" })).rejects.toThrow("sender copy");
    expect((await conversation.loadDraft())?.content).toBe("hello");
    expect(pendingPublication(owner.conversation(peer))).toBe(handle);
    await publishConversationDraft(owner.conversation(peer), { content: "hello" });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(pendingPublication(conversation)).toBeUndefined();
    expect(await conversation.loadDraft()).toBeUndefined();
  });

  it("coalesces duplicate submits while the signer prepares envelopes", async () => {
    const conversation = client().conversation(peer);
    const wait = Promise.withResolvers<PreparedWrappedMessage>();
    const prepare = vi.spyOn(conversation, "prepareSend").mockReturnValue(wait.promise);
    const first = publishConversationDraft(conversation, { content: "one" });
    const second = publishConversationDraft(conversation, { content: "one" });
    const handle = prepared(rumor("one"));
    wait.resolve(handle);
    await Promise.all([first, second]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(handle.publish).toHaveBeenCalledTimes(1);
  });

  it("retains accepted envelopes when clearing the persisted draft fails", async () => {
    const conversation = client().conversation(peer);
    await conversation.setDraft({ content: "one" });
    const handle = prepared(rumor("one"));
    const prepare = vi.spyOn(conversation, "prepareSend").mockResolvedValue(handle);
    vi.spyOn(conversation, "clearDraft").mockRejectedValueOnce(new Error("disk full"));
    await expect(publishConversationDraft(conversation, { content: "one" })).rejects.toThrow("disk full");
    expect(pendingPublication(conversation)).toBe(handle);
    await publishConversationDraft(conversation, { content: "one" });
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("does not clear a newer draft when an old publication completes", async () => {
    const conversation = client().conversation(peer);
    const wait = Promise.withResolvers<Rumor>();
    vi.spyOn(conversation, "prepareSend").mockResolvedValue(prepared(rumor("old"), vi.fn(() => wait.promise)));
    const sending = publishConversationDraft(conversation, { content: "old" });
    await conversation.setDraft({ content: "new" });
    wait.resolve(rumor("old"));
    await sending;
    expect((await conversation.loadDraft())?.content).toBe("new");
  });
});

describe("DM conversation list integration", () => {
  it("keeps a live arrival when an older enumeration page finishes later", async () => {
    const owner = client();
    const updates = new Subject<WrappedConversationSummary>();
    const inserts = new Subject<WrappedConversationSummary>();
    const page = Promise.withResolvers<void>();
    let enumerated = false;
    const old = { id: `${self}:${peer}`, participants: [self, peer], lastActivity: 1, lastMessage: rumor("old", 1) };
    const source: ConversationSource = {
      pubkey: self, rumorStore: owner.rumorStore, conversation: owner.conversation.bind(owner),
      conversationInserts$: inserts, conversationUpdates$: updates,
      async *conversations() { await page.promise; yield old; enumerated = true; },
    };
    let latest: WrappedConversationSummary[] = [];
    const subscription = conversationSummaries(source).subscribe((summaries) => { latest = summaries; });
    cleanups.push(() => subscription.unsubscribe());
    inserts.next({ ...old, lastActivity: 2, lastMessage: rumor("new", 2) });
    updates.next({ ...old, id: "group", participants: [self, peer, "c".repeat(64)] });
    page.resolve();
    await vi.waitFor(() => expect(enumerated).toBe(true));
    expect(latest[0]?.lastMessage?.content).toBe("new");
    expect(latest).toHaveLength(1);
  });

  it("refreshes a removed newest preview through the SDK conversation", async () => {
    const owner = client();
    const old = rumor("retained", unixNow() - 2);
    const newest = rumor("removed", unixNow() - 1);
    await owner.rumorStore.add(old);
    await owner.rumorStore.add(newest);
    let latest: WrappedConversationSummary[] = [];
    const subscription = conversationSummaries(owner).subscribe((summaries) => { latest = summaries; });
    cleanups.push(() => subscription.unsubscribe());
    await vi.waitFor(() => expect(latest[0]?.lastMessage?.id).toBe(newest.id));
    await owner.rumorStore.remove(newest);
    await vi.waitFor(() => expect(latest[0]?.lastMessage?.id).toBe(old.id));
  });
});

describe("DM storage adapters", () => {
  it("restores encrypted drafts and decryption caches without crossing accounts or namespaces", async () => {
    const id = crypto.randomUUID();
    const first = await openMessageStorage(id);
    await first.draftStorage.setItem("same", "private draft");
    await first.decryptionCache.setItem("same", "private rumor");
    await first.close();
    const restored = await openMessageStorage(id);
    const other = await openMessageStorage(`${id}-other`);
    cleanups.push(() => restored.close(), () => other.close());
    expect(await restored.draftStorage.getItem("same")).toBe("private draft");
    expect(await restored.decryptionCache.getItem("same")).toBe("private rumor");
    expect(await other.draftStorage.getItem("same")).toBeNull();
    expect(await other.decryptionCache.getItem("same")).toBeNull();
  });
});
