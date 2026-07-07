// Holds the one active call and lazy-loads the LiveKit room, so the ~0.5MB
// livekit-client bundle stays out of the boot path and the connection survives
// navigation between channels/communities (the provider lives above the router
// shell). Joining resolves the §5 rendezvous broker before the room mounts.
//
// The room itself stays mounted here at the root (so its audio + connection
// outlive navigation), but its visible surface is portaled by VoiceRoom into a
// slot the current voice channel's view registers (`stageEl`) — so the call
// renders center-top of that channel with chat below, and shrinks to a
// minimized bar when you browse elsewhere.

import { Suspense, lazy, useCallback, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useConcord } from "../concord-context";
import { resolveVoiceBroker } from "./brokers";
import { CallContext, type ActiveCall, type CallRequest } from "./call-context";

const VoiceRoom = lazy(() => import("./VoiceRoom").then((m) => ({ default: m.VoiceRoom })));

export function CallProvider({ children }: { children: ReactNode }) {
  const client = useConcord();
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [pending, setPending] = useState<CallRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stageEl, setStageEl] = useState<HTMLElement | null>(null);
  // Guards against a stale broker-resolution completing after a newer join/leave.
  const joinSeq = useRef(0);

  const leave = useCallback(() => {
    joinSeq.current++;
    setPending(null);
    setActive(null);
    setError(null);
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const join = useCallback(
    (req: CallRequest) => {
      const voice = client.voiceKeys(req.cid, req.channelId);
      if (!voice) return; // not a voice channel
      const seq = ++joinSeq.current;
      setError(null);
      setActive(null);
      setPending(req);
      void (async () => {
        const fold = client.getVoicePresence$(req.cid, req.channelId).value;
        const broker = await resolveVoiceBroker(voice.room.pk, fold);
        if (seq !== joinSeq.current) return; // superseded
        setPending(null);
        if (!broker) {
          setError("No reachable voice broker. Set VITE_CONCORD_AV_SERVERS.");
          return;
        }
        setActive({ ...req, broker });
      })();
    },
    [client],
  );

  // §5 split-heal: jump the live call to a broker that beats ours in the
  // tie-break. Bumps joinSeq so any in-flight resolution is discarded, and the
  // new broker in the key remounts VoiceRoom with a fresh connection.
  const migrate = useCallback((broker: string) => {
    joinSeq.current++;
    setActive((a) => (a && a.broker !== broker ? { ...a, broker } : a));
  }, []);

  const controller = useMemo(
    () => ({ active, pending, error, join, migrate, leave, clearError, stageEl, setStageEl }),
    [active, pending, error, join, migrate, leave, clearError, stageEl],
  );

  return (
    <CallContext.Provider value={controller}>
      {children}
      {active && (
        <Suspense fallback={null}>
          <VoiceRoom key={`${active.cid}:${active.channelId}:${active.broker}`} call={active} onLeave={leave} />
        </Suspense>
      )}
    </CallContext.Provider>
  );
}
