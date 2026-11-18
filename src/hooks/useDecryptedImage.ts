import { useEffect, useState } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ConcordCommunity, ConcordMediaUnavailableReason } from "@applesauce/concord";
import { createMediaURLScope } from "../services/concord-media";

/** Only current, joined-community images are read. The SDK deliberately rejects
 * legacy SVG (and unknown signatures); callers retain their initials/empty fallback. */
export function useCommunityImage(community: ConcordCommunity | undefined, kind: "icon" | "banner") {
  const account = useActiveAccount();
  const metadata = use$(community?.metadata$);
  const dissolved = use$(community?.dissolved$);
  const identity = JSON.stringify(metadata?.[kind]);
  const [result, setResult] = useState<{ owner: ConcordCommunity; account: string; identity: string | undefined; url: string | null; reason?: ConcordMediaUnavailableReason; signal: AbortSignal } | null>(null);
  useEffect(() => {
    if (!community || !account || dissolved || !identity) return;
    const scope = createMediaURLScope(account.pubkey, community.material.community_id, () => setResult(null));
    // Revoke immediately on access/pointer loss, without waiting for React's next effect.
    const metadataSub = community.metadata$.subscribe((value) => {
      if (JSON.stringify(value?.[kind]) !== identity) scope.dispose();
    });
    const dissolvedSub = community.dissolved$.subscribe((value) => { if (value) scope.dispose(); });
    void community.media.readImage(kind, { signal: scope.signal }).then((value) => {
      if (scope.signal.aborted) return;
      if (value.status !== "ready") {
        setResult({ owner: community, account: account.pubkey, identity, url: null, reason: value.reason, signal: scope.signal });
        return;
      }
      const url = scope.create(value.blob);
      if (url) setResult({ owner: community, account: account.pubkey, identity, url, signal: scope.signal });
    }).catch(() => {
      if (!scope.signal.aborted) setResult({ owner: community, account: account.pubkey, identity, url: null, reason: "download-failed", signal: scope.signal });
    });
    return () => { metadataSub.unsubscribe(); dissolvedSub.unsubscribe(); scope.dispose(); };
  }, [community, account, kind, identity, dissolved]);
  return !dissolved && result && !result.signal.aborted && result.account === account?.pubkey &&
    result.owner === community && result.identity === identity ? { src: result.url, reason: result.reason } : { src: null };
}

export function useDecryptedImage(community: ConcordCommunity | undefined, kind: "icon" | "banner"): string | null {
  return useCommunityImage(community, kind).src;
}
