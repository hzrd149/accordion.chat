// Concord AV broker configuration + rendezvous resolution (CORD-07 §2, §5).
//
// A broker is a blind LiveKit token endpoint. We hold no relay of our own, so
// the default broker is the public Armada instance (`https://armada.buzz`), whose
// relay hosts a CORD-07 `/.well-known/concord/av` broker + LiveKit SFU — so E2E
// calls work out of the box. Operators override with `VITE_CONCORD_AV_SERVERS`
// (comma-separated https origins) or set it empty to disable voice. When a call
// is already live, the participants' presence-announced broker is the rendezvous
// point and our defaults are only the empty-room fallback (§5).

import {
  canonicalOrigin,
  probeAvBroker,
  rendezvousCandidates,
  type VoicePresenceFold,
} from "../../voice/presence";

/** The public Armada broker: a blind CORD-07 token endpoint + LiveKit SFU. */
const DEFAULT_PUBLIC_AV_SERVER = "https://armada.buzz";

/** The client's own preferred brokers, in order — the empty-room fallback (§5). */
export const CONCORD_AV_SERVERS: string[] = (
  import.meta.env.VITE_CONCORD_AV_SERVERS ?? DEFAULT_PUBLIC_AV_SERVER
)
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
