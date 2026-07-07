// Concord AV broker configuration + rendezvous resolution (CORD-07 §2, §5).
//
// A broker is a blind LiveKit token endpoint. We hold no relay of our own, so
// the default brokers come from `VITE_CONCORD_AV_SERVERS` (comma-separated https
// origins) — point it at an armada deployment's `/.well-known/concord/av`. When
// a call is already live, the participants' presence-announced broker is the
// rendezvous point and our defaults are only the fallback (§5).

import {
  canonicalOrigin,
  probeAvBroker,
  rendezvousCandidates,
  type VoicePresenceFold,
} from "../../concord/voice";

/** The client's own preferred brokers, in order — the empty-room fallback (§5). */
export const CONCORD_AV_SERVERS: string[] = (import.meta.env.VITE_CONCORD_AV_SERVERS ?? "")
  .split(",")
  .map((s: string) => s.trim())
  .filter((s: string): s is string => Boolean(s))
  .map((s: string) => canonicalOrigin(s))
  .filter((o: string | null): o is string => Boolean(o));

/**
 * Resolve which broker to join for a room: the §5 candidate order (occupied
 * brokers first, own defaults as fallback), probing each capability endpoint and
 * taking the first reachable one. Returns null if none answer.
 */
export async function resolveVoiceBroker(
  roomHex: string,
  fold: VoicePresenceFold,
  signal?: AbortSignal,
): Promise<string | null> {
  const candidates = rendezvousCandidates(roomHex, fold, CONCORD_AV_SERVERS);
  for (const origin of candidates) {
    if (await probeAvBroker(origin, signal)) return origin;
  }
  return null;
}
