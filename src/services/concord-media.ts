import { Media, type ConcordClient } from "@applesauce/concord";
import { DEFAULT_BLOSSOM_SERVERS } from "../helpers/blossom";

/** Only app-configured origins are trusted, never URLs supplied by messages or metadata.
 * Custom Blossom deployments must explicitly opt in via this comma-separated setting. */
export function createMediaTransport(extraOrigins = "") {
  const origins = [...DEFAULT_BLOSSOM_SERVERS.map((value) => new URL(value).origin),
    ...extraOrigins.split(",").map((value) => value.trim()).filter(Boolean)];
  return Media.createFetchMediaTransport({ allowedOrigins: origins });
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
