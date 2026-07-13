// The E2E-encrypted LiveKit room for a Concord voice/video call (CORD-07).
//
// Mirrors armada's ConcordVoiceRoom: a token from the blind broker (authorized
// by channel-key possession, not membership), media encrypted end-to-end under
// per-sender keys the SFU never sees, and presence announced over the channel
// itself (driven by ConcordClient.joinVoice). LiveKit's built-in E2EE worker
// does the AES-256-GCM frame crypto; a custom key provider feeds it the
// externally-derived per-identity key material.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { AudioTrack, LiveKitRoom, useTracks, type TrackReference } from "@livekit/components-react";
import { Loader2, PhoneOff } from "lucide-react";
import {
  AudioPresets,
  BaseKeyProvider,
  DisconnectReason,
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RoomOptions,
} from "livekit-client";
import { use$, useActiveAccount } from "applesauce-react/hooks";

import {
  fetchAvToken,
  rendezvousCandidates,
  verifiedAuthorOf,
  type AvToken,
  type VoicePresenceFold,
} from "../../voice/presence";
import { useVoiceEngine } from "../../voice/registry";
import { useCall } from "./call-context";
import { voiceSenderKey } from "applesauce-concord/helpers";
import { randomBytes } from "../../lib/bytes";
import { CallStage } from "./CallStage";
import { CallBar } from "./CallBar";
import { FloatingCallBox } from "./FloatingCallBox";
import { playJoinSound, playLeaveSound } from "./callSounds";
import { VoiceIdentityContext, useVoiceIdentity, type VoiceIdentityResolver } from "./identity";
import type { ActiveCall } from "./call-context";

const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map() };
const VOLUME_STORAGE_KEY = "accordion:voice-participant-volumes";

type ParticipantVolumes = Record<string, number>;

function clampVolume(volume: number): number {
  return Math.min(1, Math.max(0, volume));
}

function loadParticipantVolumes(): ParticipantVolumes {
  try {
    const raw = localStorage.getItem(VOLUME_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([key, value]) =>
        typeof value === "number" && Number.isFinite(value) ? [[key, clampVolume(value)]] : [],
      ),
    );
  } catch {
    return {};
  }
}

function saveParticipantVolumes(volumes: ParticipantVolumes) {
  try {
    localStorage.setItem(VOLUME_STORAGE_KEY, JSON.stringify(volumes));
  } catch {
    // Best-effort preference persistence only.
  }
}

function participantVolumeKey(identity: string, resolve: VoiceIdentityResolver): string {
  const info = resolve(identity);
  return info.verified ? info.pubkey : identity;
}

function ParticipantAudioRenderer({ volumes }: { volumes: ParticipantVolumes }) {
  const resolve = useVoiceIdentity();
  const tracks = useTracks([Track.Source.Microphone, Track.Source.ScreenShareAudio, Track.Source.Unknown], {
    updateOnlyOn: [],
    onlySubscribed: true,
  }).filter(
    (ref): ref is TrackReference =>
      ref.publication !== undefined && !ref.participant.isLocal && ref.publication.kind === Track.Kind.Audio,
  );

  return (
    <div style={{ display: "none" }}>
      {tracks.map((trackRef) => (
        <AudioTrack
          key={`${trackRef.participant.identity}:${trackRef.publication.trackSid}`}
          trackRef={trackRef}
          volume={volumes[participantVolumeKey(trackRef.participant.identity, resolve)] ?? 1}
        />
      ))}
    </div>
  );
}

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
  const account = useActiveAccount();
  const { cid, channelId, broker } = call;
  const engine = useVoiceEngine(cid);

  const voice = useMemo(() => engine?.voiceKeys(channelId), [engine, channelId]);
  const fold =
    use$(() => (engine ? engine.getVoicePresence$(channelId) : undefined), [engine, channelId]) ?? EMPTY_FOLD;

  // Token from the blind broker (§2). Fetched exactly once per (room, broker) and
  // NEVER refetched: the identity is baked into the token and drives the frame
  // keys, so a refetch would change who we are mid-call. A single shared promise
  // (not a fresh fetch per effect run) is essential — the grant's event id is
  // deterministic within a second, so two grants would collide and the broker's
  // anti-replay would 401 the second (e.g. React StrictMode's double-invoke).
  const [tokenData, setTokenData] = useState<AvToken | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [participantVolumes, setParticipantVolumes] = useState<ParticipantVolumes>(loadParticipantVolumes);
  const setParticipantVolume = useCallback((key: string, volume: number) => {
    const next = clampVolume(volume);
    setParticipantVolumes((current) => ({ ...current, [key]: next }));
  }, []);
  useEffect(() => saveParticipantVolumes(participantVolumes), [participantVolumes]);
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
    if (!tokenData || !engine) return;
    void engine.joinVoice(channelId, tokenData.identity, broker);
    return () => {
      void engine.leaveVoice(channelId);
    };
  }, [engine, channelId, tokenData, broker]);

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
        // Match armada's known-good voice profile exactly: musicHighQuality
        // (96 kbps) Opus with RED (packet-loss resilience) + DTX (don't transmit
        // silence). These ride BELOW the E2EE frame crypto — the insertable-
        // streams worker encrypts whole encoded frames regardless of codec — so
        // they don't interact with decryption. (An earlier build disabled RED/DTX
        // chasing an audio-garble bug; the real cause was the LiveKit version, not
        // the codec — video was corrupted too, which RED can't touch.)
        audioPreset: AudioPresets.musicHighQuality,
        red: true,
        dtx: true,
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

  // Enable E2EE *before* connecting, and gate the connection on it (`e2eeReady`).
  // This ordering is load-bearing: on SignalConnected LiveKit's E2EEManager runs
  // `setParticipantCryptorEnabled(localParticipant.isE2EEEnabled, …)` once, so the
  // local frame cryptor is turned on only if `encryptionType` is ALREADY GCM at
  // connect time. `setE2EEEnabled(true)` sets that synchronously (even pre-connect,
  // before its no-track early-return), so awaiting it before we connect guarantees
  // the cryptor activates. Enabling it *after* connect — the obvious `tokenData`
  // effect — loses a race against the SFU handshake: the token round-trip often
  // resolves after SignalConnected (always so under React StrictMode's remount),
  // leaving encryption GCM on paper but every remote frame silently dropped
  // (failureTolerance:-1 suppresses the error). Bug hunted down via
  // scripts/drive-voice-audio.mjs — audio was mute with E2EE on, perfect with it off.
  const [e2eeReady, setE2eeReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await e2ee.room.setE2EEEnabled(true);
      } catch (err) {
        console.warn("failed to enable Concord voice E2EE", err);
      }
      if (!cancelled) setE2eeReady(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [e2ee]);
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
  const { migrate, stageEl, expanded, setExpanded } = useCall();
  const migrated = useRef(false);
  useEffect(() => {
    if (!tokenData || !voice || migrated.current) return;
    const winner = rendezvousCandidates(voice.room.pk, fold, [])[0];
    if (!winner || winner === broker) return;
    const occupiedByOther = fold.present.some((p) => p.broker === winner && p.identity !== tokenData.identity);
    if (occupiedByOther) {
      migrated.current = true;
      migrate(winner);
    }
  }, [fold, tokenData, voice, broker, migrate]);

  // Identity → member resolution for the call UI (§4): our own identity is us;
  // anyone else's renders as a member only under a sole fresh presence claim.
  const resolveIdentity: VoiceIdentityResolver = (identity) => {
    if (tokenData && identity === tokenData.identity) return { pubkey: account?.pubkey ?? "", verified: true };
    const author = verifiedAuthorOf(fold, identity);
    return author ? { pubkey: author, verified: true } : { pubkey: identity, verified: false };
  };

  // The visible call surface renders into the current voice channel's slot
  // (`stageEl`, center-top with chat below) when that channel is on screen, full
  // screen when expanded, or a draggable/resizable floating box when you're
  // browsing elsewhere (`draggable`; transient error/connecting states use a
  // simple fixed bar instead). Either way it's a portal, so the LiveKit
  // connection stays mounted here at the root.
  const host = (node: ReactNode, draggable = false) => {
    if (expanded) {
      return createPortal(
        <div className="fixed inset-0 z-[70] flex min-h-0 flex-col overflow-hidden bg-base-100 text-base-content">
          {node}
        </div>,
        document.body,
      );
    }
    if (stageEl) {
      return createPortal(
        <div className="mx-auto mt-2.5 mb-1 flex w-[min(860px,calc(100%-24px))] flex-col overflow-hidden rounded-lg border border-base-300 bg-base-200 shadow-lg">
          {node}
        </div>,
        stageEl,
      );
    }
    if (draggable) return createPortal(<FloatingCallBox>{node}</FloatingCallBox>, document.body);
    return createPortal(
      <div className="fixed left-1/2 top-3 z-[60] flex w-[min(420px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-lg border border-base-300 bg-base-200 shadow-2xl">
        {node}
      </div>,
      document.body,
    );
  };

  if (error) {
    return host(
      <div className="flex items-center gap-2.5 px-4 py-3 text-error">
        <span>Voice unavailable: {error}</span>
        <button className="btn btn-ghost" onClick={onLeave}>
          Dismiss
        </button>
      </div>,
    );
  }
  if (!voice || !tokenData || !e2eeReady) {
    return host(
      <div className="flex items-center gap-2.5 px-4 py-3 text-base-content">
        <Loader2 className="animate-spin" size={16} />
        <span>Connecting to #{call.channelName}…</span>
        <button className="btn btn-ghost" onClick={onLeave}>
          Cancel
        </button>
      </div>,
    );
  }

  return (
    <VoiceIdentityContext.Provider value={resolveIdentity}>
      <LiveKitRoom
        className="[display:contents]"
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
        <ParticipantAudioRenderer volumes={participantVolumes} />
        {host(
          <>
            {(!stageEl || expanded) && (
              <div className="flex items-center gap-2.5 border-b border-base-300 px-3 py-2">
                <span className="flex-1 text-sm font-semibold text-base-content">
                  In call · #{call.channelName}
                </span>
                <button
                  className="btn btn-error btn-circle btn-sm"
                  title="Leave call"
                  onClick={onLeave}
                >
                  <PhoneOff size={16} />
                </button>
              </div>
            )}
            <CallStage
              channelName={call.channelName}
              expanded={expanded}
              fill={!expanded && !stageEl}
              volumes={participantVolumes}
              onVolumeChange={setParticipantVolume}
            />
            <CallBar expanded={expanded} onToggleExpanded={() => setExpanded(!expanded)} onLeave={onLeave} />
          </>,
          true,
        )}
      </LiveKitRoom>
    </VoiceIdentityContext.Provider>
  );
}
