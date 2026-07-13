// One VoiceEngine per community, shared across the voice UI (roster, call
// provider, room). The engine holds the presence subscription + heartbeat timers,
// so every consumer of a community's voice must see the same instance — hence a
// registry keyed by the ConcordCommunity object.

import type { ConcordClient, ConcordCommunity } from "applesauce-concord";
import { useCommunity } from "../hooks/use-community";
import { VoiceEngine } from "./engine";

const engines = new Map<ConcordCommunity, VoiceEngine>();

/** The shared VoiceEngine for a community (created on first use). */
export function voiceEngineFor(community: ConcordCommunity): VoiceEngine {
  let engine = engines.get(community);
  if (!engine) {
    engine = new VoiceEngine(community);
    engines.set(community, engine);
  }
  return engine;
}

/** Resolve the active community's VoiceEngine, or undefined until it's known. */
export function useVoiceEngine(cid: string | undefined): VoiceEngine | undefined {
  const community = useCommunity(cid);
  return community ? voiceEngineFor(community) : undefined;
}

/**
 * Dispose engines whose community the manager has dropped (leave/logout), and
 * return a teardown that disposes every remaining engine — call it when the
 * client is torn down (provider unmount / account switch).
 */
export function attachVoiceGc(client: ConcordClient): () => void {
  const sub = client.communities$.subscribe(() => {
    const live = new Set(client.communities$.value.map((s) => s.material.community_id));
    for (const [community, engine] of engines) {
      if (!live.has(community.communityId)) {
        engine.dispose();
        engines.delete(community);
      }
    }
  });
  return () => {
    sub.unsubscribe();
    for (const engine of engines.values()) engine.dispose();
    engines.clear();
  };
}
