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

import { UserAvatar, UserName } from "../User";
import { useVoiceIdentity } from "./identity";

function TileLabel({ identity }: { identity: string }) {
  const resolve = useVoiceIdentity();
  const info = resolve(identity);
  if (!info.verified) return <span className="call-tile-name unverified">Unverified</span>;
  return (
    <span className="call-tile-name">
      <UserName pubkey={info.pubkey} />
    </span>
  );
}

function VideoTile({ track }: { track: TrackReference }) {
  const identity = track.participant.identity;
  return (
    <div className="call-tile call-tile-video">
      <VideoTrack trackRef={track} />
      <TileLabel identity={identity} />
    </div>
  );
}

function AvatarTile({ participant }: { participant: Participant }) {
  const resolve = useVoiceIdentity();
  const info = resolve(participant.identity);
  return (
    <div className={`call-tile call-tile-avatar ${participant.isSpeaking ? "speaking" : ""}`}>
      {info.verified ? (
        <UserAvatar pubkey={info.pubkey} className="call-avatar" />
      ) : (
        <div className="call-avatar unverified">?</div>
      )}
      {participant.isMicrophoneEnabled === false && <span className="call-tile-muted">🔇</span>}
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
    <div className="call-stage">
      <div className="call-stage-title">#{channelName} · {participants.length} in call</div>
      <div className="call-grid">
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
