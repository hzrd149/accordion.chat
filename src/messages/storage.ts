import { Databases } from "@applesauce/concord";
import { AsyncRumorStore } from "applesauce-core/event-store";
import { IndexedDBConversationIndexStore } from "applesauce-extra/messages";
import { createConcordStorage } from "../services/concord-storage";
import { accountStorageLease, registerAccountResource } from "../services/account-lifecycle";

/** Reuse the device-encrypted storage adapter with a disjoint account namespace.
 * Neither drafts nor decrypted envelope/seal contents enter the public cache.
 * Decrypted rumors persist in their own plaintext IndexedDB database (like Concord
 * history), so conversations reload and page from the rumor store without network. */
export async function openMessageStorage(pubkey: string) {
  const assertActive = accountStorageLease(pubkey);
  assertActive();
  const encrypted = createConcordStorage(`dm:${pubkey}`);
  const openingIndex = IndexedDBConversationIndexStore.open(`accordion:dm-index:${pubkey}`);
  const rumorDatabases = Databases.createIndexedDBDatabaseFactory(pubkey, { prefix: "accordion:dm-rumors:v1" });
  const rumorStore = new AsyncRumorStore({ database: rumorDatabases("nip17", "inbox") });
  const close = registerAccountResource(pubkey, async () => {
    rumorStore.dispose();
    (await openingIndex.catch(() => undefined))?.close();
    await Promise.all([rumorDatabases.close(), encrypted.close()]);
  });
  let conversationIndex: IndexedDBConversationIndexStore;
  try {
    conversationIndex = await openingIndex;
    assertActive();
  } catch (error) {
    await close();
    throw error;
  }
  const scoped = (prefix: string) => ({
    getItem: async (key: string) => (await encrypted.getItem(`${prefix}:${key}`)) ?? null,
    setItem: (key: string, value: string) => encrypted.setItem(`${prefix}:${key}`, value),
    removeItem: (key: string) => encrypted.removeItem(`${prefix}:${key}`),
  });
  return {
    conversationIndex,
    rumorStore,
    draftStorage: scoped("drafts"),
    decryptionCache: scoped("decryption"),
    /** Dispose the messages client first. */
    close,
  };
}
