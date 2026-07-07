// The E2E-encrypted LiveKit room for a Concord voice/video call (CORD-07).
//
// Mirrors armada's ConcordVoiceRoom: a token from the blind broker (authorized
// by channel-key possession, not membership), media encrypted end-to-end under
// per-sender keys the SFU never sees, and presence announced over the channel
// itself (driven by ConcordClient.joinVoice). LiveKit's built-in E2EE worker
// does the AES-256-GCM frame crypto; a custom key provider feeds it the
// externally-derived per-identity key material.

import { useEffect, useMemo, useRef, useState } from "react";
import { LiveKitRoom, RoomAudioRenderer } from "@livekit/components-react";
import {
  BaseKeyProvider,
  DisconnectReason,
  Room,
  RoomEvent,
  VideoPresets,
  type RoomOptions,
} from "livekit-client";
import { use$ } from "applesauce-react/hooks";

import { useConcord } from "../concord-context";
import {
  fetchAvToken,
  rendezvousCandidates,
  verifiedAuthorOf,
  type AvToken,
  type VoicePresenceFold,
} from "../../concord/voice";
import { useCall } from "./call-context";
import { voiceSenderKey } from "../../concord/crypto";
import { randomBytes } from "../../lib/bytes";
import { CallStage } from "./CallStage";
import { CallBar } from "./CallBar";
import { playJoinSound, playLeaveSound } from "./callSounds";
import { VoiceIdentityContext, type VoiceIdentityResolver } from "./identity";
import type { ActiveCall } from "./call-context";

const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map() };

/**
 * A per-sender key provider for Concord AV (CORD-07 §3): every publisher
 * encrypts under its own key, derived from the channel's media root and the
 * publisher's broker-assigned identity — so members never share one AEAD nonce
 * domain. CORD-07's profile:
 *   - sharedKey: false     — keys are per participant identity;
 *   - keySize: 256         — AES-256-GCM frame keys (LiveKit defaults to 128);
 *   - ratchetWindowSize: 0, failureTolerance: -1 — keys are EXTERNALLY derived;
 *     LiveKit's auto-ratchet-on-failure would silently diverge every receiver
 *     from the deterministic derivation, so it must never fire.
 */
class SenderKeyProvider extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  }

  /** Install `material` as `identity`'s frame-key material (HKDF input). */
  async setSenderMaterial(material: Uint8Array, identity: string): Promise<void> {
    const key = await crypto.subtle.importKey("raw", material.slice().buffer as ArrayBuffer, "HKDF", false, [
      "deriveBits",
      "deriveKey",
    ]);
    this.onSetEncryptionKey(key, identity);
  }
}

export function VoiceRoom({ call, onLeave }: { call: ActiveCall; onLeave: () => void }) {
  const client = useConcord();
  const { cid, channelId, broker } = call;

  const voice = useMemo(() => client.voiceKeys(cid, channelId), [client, cid, channelId]);
  const fold = use$(() => client.getVoicePresence$(cid, channelId), [cid, channelId]) ?? EMPTY_FOLD;

  // Token from the blind broker (§2). Fetched exactly once per (room, broker) and
  // NEVER refetched: the identity is baked into the token and drives the frame
  // keys, so a refetch would change who we are mid-call. A single shared promise
  // (not a fresh fetch per effect run) is essential — the grant's event id is
  // deterministic within a second, so two grants would collide and the broker's
  // anti-replay would 401 the second (e.g. React StrictMode's double-invoke).
  const [tokenData, setTokenData] = useState<AvToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenReq = useRef<{ key: string; promise: Promise<AvToken> } | null>(null);
  useEffect(() => {
    if (!voice) return;
    const key = `${voice.room.pk}:${broker}`;
    if (tokenReq.current?.key !== key) {
      tokenReq.current = { key, promise: fetchAvToken(broker, voice.room) };
    }
    let cancelled = false;
    tokenReq.current.promise.then(
      (t) => {
        if (!cancelled) setTokenData(t);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "voice token failed");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [voice, broker]);

  // Announce presence over the channel (§4) while we hold a token: joined now +
  // every 30s, left on teardown. Driven by ConcordClient so the fold that keys
  // this very room also carries our own heartbeat to everyone else.
  useEffect(() => {
    if (!tokenData) return;
    void client.joinVoice(cid, channelId, tokenData.identity, broker);
    return () => {
      void client.leaveVoice(cid, channelId);
    };
  }, [client, cid, channelId, tokenData, broker]);

  // Build the E2EE-enabled Room once per mount (the component remounts per
  // room/epoch/broker via its key in CallProvider).
  const e2ee = useMemo(() => {
    const keyProvider = new SenderKeyProvider();
    const worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
    const opts: RoomOptions = {
      adaptiveStream: true,
      dynacast: true,
      e2ee: { keyProvider, worker },
      // Browser mic defaults tuned for voice: cancel echo/noise so two people on
      // one network don't feed back, and normalize levels.
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      videoCaptureDefaults: { resolution: VideoPresets.h720.resolution },
      publishDefaults: {
        // CRITICAL for E2EE audio: LiveKit leaves Opus RED (redundant encoding)
        // on for mono tracks even with E2EE, but RED's redundant-frame recovery
        // layered over the insertable-streams frame crypto delivers duplicated /
        // reordered frames to the decoder — heard as screeching/garble. DTX
        // (silence suppression) similarly glitches on resume under E2EE. Disable
        // both; they only trade a little packet-loss resilience, and this is a
        // per-publisher transport choice, so it stays interoperable with peers
        // that keep them on.
        red: false,
        dtx: false,
        videoSimulcastLayers: [VideoPresets.h180, VideoPresets.h360, VideoPresets.h720],
        screenShareEncoding: VideoPresets.h1080.encoding,
      },
    };
    return { room: new Room(opts), keyProvider, worker };
  }, []);

  // Key management (§3 + §7): every VERIFIED participant's frame key derives from
  // the media root + their identity; an unverified identity (unclaimed, or
  // contested by more than one fresh presence claim) gets a random key instead,
  // so its tracks fail to decode and are never rendered — the §7 SHOULD. Our own
  // identity is always keyed (we don't wait for our heartbeat to echo back).
  const applied = useRef(new Map<string, string>());
  useEffect(() => {
    if (!tokenData || !voice) return;
    const room = e2ee.room;
    const mediaKey = voice.mediaKey;

    const syncKeys = () => {
      const identities = new Set<string>([tokenData.identity]);
      for (const p of room.remoteParticipants.values()) identities.add(p.identity);
      for (const p of fold.present) identities.add(p.identity);
      for (const identity of identities) {
        const verified = identity === tokenData.identity || Boolean(verifiedAuthorOf(fold, identity));
        const want = verified ? "sender" : "blocked";
        if (applied.current.get(identity) === want) continue;
        applied.current.set(identity, want);
        const material = verified ? voiceSenderKey(mediaKey, identity) : randomBytes(32);
        void e2ee.keyProvider.setSenderMaterial(material, identity).catch(() => undefined);
      }
    };

    syncKeys();
    room.on(RoomEvent.ParticipantConnected, syncKeys);
    return () => {
      room.off(RoomEvent.ParticipantConnected, syncKeys);
    };
  }, [e2ee, tokenData, fold, voice]);

  // Enable E2EE once our own key is installed; terminate the worker on unmount.
  useEffect(() => {
    if (!tokenData) return;
    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await e2ee.room.setE2EEEnabled(true);
      } catch (err) {
        console.warn("failed to enable Concord voice E2EE", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee, tokenData]);
  useEffect(() => () => e2ee.worker.terminate(), [e2ee]);

  // A friendly chirp as people come and go (a remote roster change, never our
  // own connect). Synthesized, so there are no assets to ship.
  useEffect(() => {
    const room = e2ee.room;
    const onJoin = () => playJoinSound();
    const onLeave = () => playLeaveSound();
    room.on(RoomEvent.ParticipantConnected, onJoin);
    room.on(RoomEvent.ParticipantDisconnected, onLeave);
    return () => {
      room.off(RoomEvent.ParticipantConnected, onJoin);
      room.off(RoomEvent.ParticipantDisconnected, onLeave);
    };
  }, [e2ee]);

  // Split healing (§5): if presence shows the call occupied on a broker that
  // beats ours in the tie-break, migrate there — once per mount (the remount key
  // includes the broker, so a migration builds a fresh room). Guards on someone
  // ELSE being there, so two simultaneous joiners converge on one winner.
  const controller = useCall();
  const migrated = useRef(false);
  useEffect(() => {
    if (!tokenData || !voice || migrated.current) return;
    const winner = rendezvousCandidates(voice.room.pk, fold, [])[0];
    if (!winner || winner === broker) return;
    const occupiedByOther = fold.present.some((p) => p.broker === winner && p.identity !== tokenData.identity);
    if (occupiedByOther) {
      migrated.current = true;
      controller.migrate(winner);
    }
  }, [fold, tokenData, voice, broker, controller]);

  // Identity → member resolution for the call UI (§4): our own identity is us;
  // anyone else's renders as a member only under a sole fresh presence claim.
  const resolveIdentity: VoiceIdentityResolver = (identity) => {
    if (tokenData && identity === tokenData.identity) return { pubkey: client.pubkey, verified: true };
    const author = verifiedAuthorOf(fold, identity);
    return author ? { pubkey: author, verified: true } : { pubkey: identity, verified: false };
  };

  if (error) {
    return (
      <div className="call-error">
        <span>Voice unavailable: {error}</span>
        <button onClick={onLeave}>Dismiss</button>
      </div>
    );
  }
  if (!voice || !tokenData) {
    return (
      <div className="call-connecting">
        <span>Connecting to #{call.channelName}…</span>
        <button onClick={onLeave}>Cancel</button>
      </div>
    );
  }

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <LiveKitRoom
        className="call-window"
        room={e2ee.room}
        serverUrl={tokenData.url}
        token={tokenData.token}
        connect
        audio
        video={false}
        onDisconnected={(reason?: DisconnectReason) => {
          if (reason !== undefined && reason !== DisconnectReason.CLIENT_INITIATED) {
            console.warn("concord voice disconnected", DisconnectReason[reason] ?? reason);
          }
          onLeave();
        }}
      >
        <RoomAudioRenderer />
        <CallStage channelName={call.channelName} />
        <CallBar onLeave={onLeave} />
      </LiveKitRoom>
    </VoiceIdentityContext.Provider>
  );
}
