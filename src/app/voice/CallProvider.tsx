// Holds the one active call and lazy-loads the LiveKit room, so the ~0.5MB
// livekit-client bundle stays out of the boot path and the connection survives
// navigation between channels/communities (the provider lives above the router
// shell). Joining resolves the §5 rendezvous broker before the room mounts.

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
  // Guards against a stale broker-resolution completing after a newer join/leave.
  const joinSeq = useRef(0);

  const leave = useCallback(() => {
    joinSeq.current++;
    setPending(null);
    setActive(null);
    setError(null);
  }, []);

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

  const controller = useMemo(() => ({ active, pending, join, leave }), [active, pending, join, leave]);

  return (
    <CallContext.Provider value={controller}>
      {children}
      {error && (
        <div className="call-error call-float">
          <span>{error}</span>
          <button onClick={() => setError(null)}>Dismiss</button>
        </div>
      )}
      {pending && (
        <div className="call-connecting call-float">
          <span>Finding a voice broker for #{pending.channelName}…</span>
          <button onClick={leave}>Cancel</button>
        </div>
      )}
      {active && (
        <Suspense fallback={<div className="call-connecting call-float">Loading call…</div>}>
          <VoiceRoom key={`${active.cid}:${active.channelId}:${active.broker}`} call={active} onLeave={leave} />
        </Suspense>
      )}
    </CallContext.Provider>
  );
}
