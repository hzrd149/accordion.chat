import { useEffect, useState } from "react";
import type { ConcordCommunity } from "applesauce-concord";
import { useConcord } from "./concord-context";

/**
 * Resolve the per-community engine for a community id. The manager
 * (`ConcordClient`) spins a `ConcordCommunity` up asynchronously as it folds the
 * user's Community List, so `getCommunity` may be `undefined` on first render;
 * re-resolve whenever `communities$` emits (which fires as engines are added).
 */
export function useCommunity(cid: string | undefined): ConcordCommunity | undefined {
  const client = useConcord();
  const [community, setCommunity] = useState(() => (cid ? client.getCommunity(cid) : undefined));

  useEffect(() => {
    // communities$ is a BehaviorSubject, so subscribing re-resolves immediately
    // (covering a cid change) and again whenever an engine is added/removed. The
    // setState lives in the subscription callback, not the effect body.
    const sub = client.communities$.subscribe(() =>
      setCommunity(cid ? client.getCommunity(cid) : undefined),
    );
    return () => sub.unsubscribe();
  }, [client, cid]);

  return community;
}
