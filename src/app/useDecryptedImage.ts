import { useEffect, useState } from "react";

import { decryptImagePointer } from "../lib/image";
import type { BlobPointer } from "../concord/types";

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
  const [src, setSrc] = useState<string | null>(() => (image ? resolved.get(cacheKey(image)) ?? null : null));

  useEffect(() => {
    if (!image) {
      setSrc(null);
      return;
    }
    const ck = cacheKey(image);
    const ready = resolved.get(ck);
    if (ready) {
      setSrc(ready);
      return;
    }

    let cancelled = false;
    let promise = inflight.get(ck);
    if (!promise) {
      promise = decryptImagePointer(image);
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
    setSrc(null);
    promise
      .then((u) => {
        if (!cancelled) setSrc(u);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [image?.url, image?.key, image?.nonce]);

  return src;
}
