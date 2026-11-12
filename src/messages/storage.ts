import { IndexedDBConversationIndexStore } from "applesauce-extra/messages";
import { createConcordStorage } from "../lib/concord-storage";

/** Reuse the device-encrypted storage adapter with a disjoint account namespace.
 * Neither drafts nor decrypted envelope/seal contents enter the public cache. */
export async function openMessageStorage(pubkey: string) {
  const encrypted = createConcordStorage(`dm:${pubkey}`);
  const conversationIndex = await IndexedDBConversationIndexStore.open(`accordion:dm-index:${pubkey}`);
  const scoped = (prefix: string) => ({
    getItem: (key: string) => encrypted.getItem(`${prefix}:${key}`),
    setItem: (key: string, value: string) => encrypted.setItem(`${prefix}:${key}`, value),
    removeItem: (key: string) => encrypted.removeItem(`${prefix}:${key}`),
  });
  return {
    conversationIndex,
    draftStorage: scoped("drafts"),
    decryptionCache: scoped("decryption"),
    async close() {
      conversationIndex.close();
      await encrypted.close();
    },
  };
}
