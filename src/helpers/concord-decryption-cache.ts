import type { KeyValue } from "@applesauce/concord";
import type { EncryptedContentCache } from "applesauce-core/helpers";

/** The supplied account storage encrypts plaintext at rest. Keep list secrets
 * separate from gift-wrap plaintext even when both caches use event IDs. */
export function createConcordDecryptionCache(
  storage: KeyValue.ConcordStorage,
  scope: "lists" | "gift-wrap",
): EncryptedContentCache {
  const prefix = scope === "lists" ? "list-plaintext:" : "gift-wrap-plaintext:";
  return {
    getItem: async (id) => (await storage.getItem(`${prefix}${id}`)) ?? null,
    setItem: (id, plaintext) => storage.setItem(`${prefix}${id}`, plaintext),
  };
}
