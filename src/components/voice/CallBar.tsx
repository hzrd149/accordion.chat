// The in-call control bar (CORD-07 §6): mic mute, camera, screenshare, hangup.
// Reads live track state from the local participant; §7 moderation is local
// only (no enforceable server-side mute), so these govern our own publishing.

import { useLocalParticipant } from "@livekit/components-react";
import { Maximize2, Mic, MicOff, Minimize2, PhoneOff, ScreenShare, ScreenShareOff, Video, VideoOff } from "lucide-react";

import { playMuteSound, playScreenShareSound, playUnmuteSound } from "./callSounds";

export function CallBar({
  expanded,
  onToggleExpanded,
  onLeave,
}: {
  expanded: boolean;
  onToggleExpanded: () => void;
  onLeave: () => void;
}) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();

  return (
    <div className="flex flex-wrap items-center justify-center gap-2.5 p-2.5 bg-base-300 border-t border-base-100 max-sm:gap-1.5">
      <button
        className={isMicrophoneEnabled ? "btn btn-circle btn-primary" : "btn btn-circle"}
        title={isMicrophoneEnabled ? "Mute" : "Unmute"}
        onClick={() => {
          if (isMicrophoneEnabled) playMuteSound();
          else playUnmuteSound();
          void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled);
        }}
      >
        {isMicrophoneEnabled ? <Mic size={18} /> : <MicOff size={18} />}
      </button>
      <button
        className={isCameraEnabled ? "btn btn-circle btn-primary" : "btn btn-circle"}
        title={isCameraEnabled ? "Stop camera" : "Start camera"}
        onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled)}
      >
        {isCameraEnabled ? <Video size={18} /> : <VideoOff size={18} />}
      </button>
      <button
        className={isScreenShareEnabled ? "btn btn-circle btn-primary" : "btn btn-circle"}
        title={isScreenShareEnabled ? "Stop sharing" : "Share screen"}
        onClick={() => {
          if (!isScreenShareEnabled) playScreenShareSound();
          void localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true });
        }}
      >
        {isScreenShareEnabled ? <ScreenShareOff size={18} /> : <ScreenShare size={18} />}
      </button>
      <button className="btn btn-circle" title={expanded ? "Exit full screen" : "Full screen"} onClick={onToggleExpanded}>
        {expanded ? <Minimize2 size={18} /> : <Maximize2 size={18} />}
      </button>
      <button className="btn btn-error btn-circle" title="Leave call" onClick={onLeave}>
        <PhoneOff size={18} />
      </button>
    </div>
  );
}
