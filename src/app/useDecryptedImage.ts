import { useEffect, useState } from "react";

import { decryptImagePointer } from "../lib/image";
import type { BlobPointer } from "applesauce-concord";

// Resolve an encrypted {@link BlobPointer} (icon / banner) to a displayable
// object URL. Decrypt-once cache keyed on (url, key, nonce); the resolved map
// is seeded synchronously so a remount paints on the first frame. Object URLs
// are never revoked (the cache is bounded instead).

const MAX_CACHED = 128;
const inflight = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

function cacheKey(image: BlobPointer): string {
  return `${image.url}\n${image.key}\n${image.nonce}`;
}

/** Returns the decrypted object URL, or null while loading / on failure. */
export function useDecryptedImage(image: BlobPointer | undefined): string | null {
  const ck = image ? cacheKey(image) : null;
  // The resolved cache is the source of truth; `src` is derived from it each
  // render. `bump` is only a re-render trigger fired from the async callback
  // once the decrypt lands — so no state is set synchronously in the effect.
  const cached = ck ? resolved.get(ck) ?? null : null;
  const [, bump] = useState(0);

  useEffect(() => {
    if (!ck || resolved.has(ck)) return;
    let cancelled = false;
    let promise = inflight.get(ck);
    if (!promise) {
      promise = decryptImagePointer(image!);
      inflight.set(ck, promise);
      promise
        .then((u) => {
          resolved.set(ck, u);
          if (resolved.size > MAX_CACHED) {
            const oldest = resolved.keys().next().value;
            if (oldest !== undefined && oldest !== ck) resolved.delete(oldest);
          }
        })
        .catch(() => {
          if (inflight.get(ck) === promise) inflight.delete(ck);
        });
    }
    // Re-render on settle (success or failure). Two-arg form so this subscriber
    // handles its own rejection — `.finally` would leave it unhandled.
    const rerender = () => !cancelled && bump((n) => n + 1);
    promise.then(rerender, rerender);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ck]);

  return cached;
}
