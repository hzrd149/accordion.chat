// The call stage: a grid of participant tiles (CORD-07 §4, §6). Camera and
// screenshare tracks render as video; everyone else as a speaking-aware avatar.
// A participant whose SFU identity fails presence verification (§4) is shown as
// unverified — and its media never decodes anyway (VoiceRoom keys it randomly).

import {
  useParticipants,
  useTracks,
  VideoTrack,
  type TrackReference,
} from "@livekit/components-react";
import { Track, type Participant } from "livekit-client";
import { MicOff, MoreVertical, ShieldQuestion, Volume1, VolumeX } from "lucide-react";

import { UserAvatar, UserName } from "../User";
import { useVoiceIdentity } from "./identity";

function TileLabel({ identity }: { identity: string }) {
  const resolve = useVoiceIdentity();
  const info = resolve(identity);
  if (!info.verified)
    return (
      <span className="absolute left-1.5 bottom-1.5 max-w-[calc(100%-12px)] overflow-hidden text-ellipsis whitespace-nowrap rounded bg-black/55 px-1.5 py-px text-xs italic text-white">
        Unverified
      </span>
    );
  return (
    <span className="absolute left-1.5 bottom-1.5 max-w-[calc(100%-12px)] overflow-hidden text-ellipsis whitespace-nowrap rounded bg-black/55 px-1.5 py-px text-xs text-white">
      <UserName pubkey={info.pubkey} />
    </span>
  );
}

function ParticipantMenu({
  participant,
  volumes,
  onVolumeChange,
}: {
  participant: Participant;
  volumes: Record<string, number>;
  onVolumeChange: (key: string, volume: number) => void;
}) {
  const resolve = useVoiceIdentity();
  if (participant.isLocal) return null;
  const info = resolve(participant.identity);
  const volumeKey = info.verified ? info.pubkey : participant.identity;
  const volume = volumes[volumeKey] ?? 1;
  const Icon = volume === 0 ? VolumeX : Volume1;
  return (
    <div className="dropdown dropdown-end absolute right-1.5 top-1.5">
      <button className="btn btn-circle btn-xs border-0 bg-black/55 text-white hover:bg-black/70" title="Participant options">
        <MoreVertical size={14} />
      </button>
      <ul className="menu dropdown-content z-10 mt-1 w-52 overflow-hidden rounded-box border border-base-300 bg-base-100 p-0 text-base-content shadow-xl">
        <li>
          <button
            className="rounded-none"
            onClick={() => onVolumeChange(volumeKey, volume === 0 ? 1 : 0)}
          >
            {volume === 0 ? <Volume1 size={14} /> : <VolumeX size={14} />}
            {volume === 0 ? "Unmute" : "Mute"}
          </button>
        </li>
        <li>
          <label className="flex flex-col items-stretch gap-2 rounded-none text-xs font-semibold text-base-content/70">
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <Icon size={13} /> Volume
              </span>
              <span>{Math.round(volume * 100)}%</span>
            </span>
            <input
              className="range range-primary range-xs"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              title={`Volume ${Math.round(volume * 100)}%`}
              onChange={(e) => onVolumeChange(volumeKey, Number(e.currentTarget.value))}
            />
          </label>
        </li>
      </ul>
    </div>
  );
}

function VideoTile({
  track,
  volumes,
  onVolumeChange,
}: {
  track: TrackReference;
  volumes: Record<string, number>;
  onVolumeChange: (key: string, volume: number) => void;
}) {
  const identity = track.participant.identity;
  return (
    <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-base-300 [&_video]:h-full [&_video]:w-full [&_video]:object-cover">
      <VideoTrack trackRef={track} />
      <TileLabel identity={identity} />
      <ParticipantMenu participant={track.participant} volumes={volumes} onVolumeChange={onVolumeChange} />
    </div>
  );
}

function AvatarTile({
  participant,
  volumes,
  onVolumeChange,
}: {
  participant: Participant;
  volumes: Record<string, number>;
  onVolumeChange: (key: string, volume: number) => void;
}) {
  const resolve = useVoiceIdentity();
  const info = resolve(participant.identity);
  return (
    <div
      className={`relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-base-300 ${participant.isSpeaking ? "ring-2 ring-success" : ""}`}
    >
      {info.verified ? (
        <UserAvatar pubkey={info.pubkey} className="w-14 h-14" />
      ) : (
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-base-100 text-base-content opacity-60">
          <ShieldQuestion size={22} />
        </div>
      )}
      {participant.isMicrophoneEnabled === false && (
        <span className="absolute right-1.5 top-1.5">
          <MicOff size={13} />
        </span>
      )}
      <TileLabel identity={participant.identity} />
      <ParticipantMenu participant={participant} volumes={volumes} onVolumeChange={onVolumeChange} />
    </div>
  );
}

export function CallStage({
  channelName,
  expanded,
  volumes,
  onVolumeChange,
}: {
  channelName: string;
  expanded: boolean;
  volumes: Record<string, number>;
  onVolumeChange: (key: string, volume: number) => void;
}) {
  const participants = useParticipants();
  const videoTracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: true,
  }).filter((t): t is TrackReference => t.publication !== undefined);

  // Participants with no video track get an avatar tile; those with video get
  // one video tile per track (a screenshare + camera = two tiles).
  const videoIdentities = new Set(videoTracks.map((t) => t.participant.identity));
  const avatarParticipants = participants.filter((p) => !videoIdentities.has(p.identity));

  return (
    <div className={expanded ? "min-h-0 flex-1 overflow-y-auto p-4" : "max-h-[42vh] overflow-y-auto p-3"}>
      <div className={expanded ? "mb-4 text-sm font-semibold text-base-content/70" : "mb-2 text-xs font-semibold text-base-content/60"}>
        #{channelName} · {participants.length} in call
      </div>
      <div className={expanded ? "grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-3" : "grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5"}>
        {videoTracks.map((t) => (
          <VideoTile
            key={`${t.participant.identity}:${t.source}`}
            track={t}
            volumes={volumes}
            onVolumeChange={onVolumeChange}
          />
        ))}
        {avatarParticipants.map((p) => (
          <AvatarTile
            key={p.identity}
            participant={p}
            volumes={volumes}
            onVolumeChange={onVolumeChange}
          />
        ))}
      </div>
    </div>
  );
}
