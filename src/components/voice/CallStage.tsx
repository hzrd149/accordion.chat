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
import { MicOff, ShieldQuestion } from "lucide-react";

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

function VideoTile({ track }: { track: TrackReference }) {
  const identity = track.participant.identity;
  return (
    <div className="relative flex aspect-[16/10] items-center justify-center overflow-hidden rounded-lg bg-base-300 [&_video]:h-full [&_video]:w-full [&_video]:object-cover">
      <VideoTrack trackRef={track} />
      <TileLabel identity={identity} />
    </div>
  );
}

function AvatarTile({ participant }: { participant: Participant }) {
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
    </div>
  );
}

export function CallStage({ channelName }: { channelName: string }) {
  const participants = useParticipants();
  const videoTracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare], {
    onlySubscribed: true,
  }).filter((t): t is TrackReference => t.publication !== undefined);

  // Participants with no video track get an avatar tile; those with video get
  // one video tile per track (a screenshare + camera = two tiles).
  const videoIdentities = new Set(videoTracks.map((t) => t.participant.identity));
  const avatarParticipants = participants.filter((p) => !videoIdentities.has(p.identity));

  return (
    <div className="max-h-[42vh] overflow-y-auto p-3">
      <div className="mb-2 text-xs font-semibold text-base-content/60">
        #{channelName} · {participants.length} in call
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2.5">
        {videoTracks.map((t) => (
          <VideoTile key={`${t.participant.identity}:${t.source}`} track={t} />
        ))}
        {avatarParticipants.map((p) => (
          <AvatarTile key={p.identity} participant={p} />
        ))}
      </div>
    </div>
  );
}
