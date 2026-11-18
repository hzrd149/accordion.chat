import { describe, expect, it } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { createConcordDecryptionCache } from "../src/helpers/concord-decryption-cache";
import { createConcordStorage } from "../src/services/concord-storage";

describe("Concord decryption cache adapter", () => {
  it("restores list secrets across sessions, isolated from other accounts and gift wraps", async () => {
    const indexedDB = new IDBFactory();
    const options = { indexedDB, legacy: { getItem: () => null, removeItem: () => {} } };
    const storage = createConcordStorage("cache-alice", options);
    const cache = createConcordDecryptionCache(storage, "lists");
    try {
      expect(await cache.getItem("event")).toBeNull();
      await cache.setItem("event", "membership secrets");
      await cache.setItem("empty", "");
      expect(await createConcordDecryptionCache(storage, "gift-wrap").getItem("event")).toBeNull();
    } finally {
      await storage.close();
    }
    const restored = createConcordStorage("cache-alice", options);
    const other = createConcordStorage("cache-bob", options);
    try {
      expect(await createConcordDecryptionCache(restored, "lists").getItem("event")).toBe("membership secrets");
      expect(await createConcordDecryptionCache(restored, "lists").getItem("empty")).toBe("");
      expect(await createConcordDecryptionCache(other, "lists").getItem("event")).toBeNull();
    } finally {
      await Promise.all([restored.close(), other.close()]);
    }
  });
});
