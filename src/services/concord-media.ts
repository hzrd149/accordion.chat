import type { ConcordClient, ConcordMediaTransport } from "@applesauce/concord";

/** Download ciphertext from any HTTPS origin; Concord verifies and decrypts it.
 * Requests carry no credentials/referrer and remain bounded and cancellable. */
export function createMediaTransport(): ConcordMediaTransport {
  return async (value, { signal, maxBytes }) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("Expected a credential-free HTTPS media URL");
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid media byte limit");
    signal.throwIfAborted();
    const response = await fetch(url.href, {
      signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
    });
    const reader = response.body?.getReader();
    const cancel = () => { void reader?.cancel().catch(() => {}); };
    let complete = false;
    const tooLarge = () => {
      const error = new Error("Media byte limit exceeded");
      error.name = "ConcordMediaTooLarge";
      return error;
    };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (!response.ok || response.redirected) throw new Error("Media download failed");
      const length = response.headers.get("content-length");
      if (length !== null) {
        if (!/^\d+$/.test(length)) throw new Error("Invalid media content length");
        if (Number(length) > maxBytes) throw tooLarge();
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        while (true) {
          const { done, value: chunk } = await reader.read();
          signal.throwIfAborted();
          if (done) break;
          total += chunk.byteLength;
          if (total > maxBytes) throw tooLarge();
          chunks.push(chunk);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      complete = true;
      return bytes;
    } finally {
      signal.removeEventListener("abort", cancel);
      if (!complete) await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  };
}

type URLScope = ReturnType<typeof createMediaURLScope>;
const scopes = new Set<{ account: string; community: string; scope: URLScope }>();

/** One rendering owner's plaintext URLs. Late results cannot outlive that owner. */
export function createMediaURLScope(account: string, community: string, onRetire?: () => void) {
  const controller = new AbortController();
  const urls = new Set<string>();
  const scope = {
    signal: controller.signal,
    create(blob: Blob): string | null {
      if (controller.signal.aborted) return null;
      const url = URL.createObjectURL(blob);
      urls.add(url);
      return url;
    },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
      scopes.delete(record);
      onRetire?.();
    },
  };
  const record = { account, community, scope };
  scopes.add(record);
  return scope;
}

export function revokeAccountMedia(account: string) {
  for (const entry of scopes) if (entry.account === account) entry.scope.dispose();
}

/** Leaving a community retires rendering URLs even if a view still holds its old handle. */
export function attachMediaGc(client: ConcordClient, account: string) {
  const subscription = client.communities$.subscribe((communities) => {
    const ids = new Set(communities.map((community) => community.material.community_id));
    for (const entry of scopes) {
      if (entry.account === account && !ids.has(entry.community)) entry.scope.dispose();
    }
  });
  return () => { subscription.unsubscribe(); revokeAccountMedia(account); };
}

/** The old cache contained unscoped, unverified-on-read plaintext. Never import it. */
export async function retireLegacyImageCache(storage: Pick<CacheStorage, "delete"> | undefined = globalThis.caches) {
  if (storage) await storage.delete("concord-images");
}
