// The in-call control bar (CORD-07 §6): mic mute, camera, screenshare, hangup.
// Reads live track state from the local participant; §7 moderation is local
// only (no enforceable server-side mute), so these govern our own publishing.

import { useLocalParticipant } from "@livekit/components-react";

export function CallBar({ onLeave }: { onLeave: () => void }) {
  const { localParticipant, isMicrophoneEnabled, isCameraEnabled, isScreenShareEnabled } =
    useLocalParticipant();

  return (
    <div className="call-bar">
      <button
        className={isMicrophoneEnabled ? "call-btn active" : "call-btn"}
        title={isMicrophoneEnabled ? "Mute" : "Unmute"}
        onClick={() => void localParticipant.setMicrophoneEnabled(!isMicrophoneEnabled)}
      >
        {isMicrophoneEnabled ? "🎙️" : "🔇"}
      </button>
      <button
        className={isCameraEnabled ? "call-btn active" : "call-btn"}
        title={isCameraEnabled ? "Stop camera" : "Start camera"}
        onClick={() => void localParticipant.setCameraEnabled(!isCameraEnabled)}
      >
        {isCameraEnabled ? "📹" : "📷"}
      </button>
      <button
        className={isScreenShareEnabled ? "call-btn active" : "call-btn"}
        title={isScreenShareEnabled ? "Stop sharing" : "Share screen"}
        onClick={() => void localParticipant.setScreenShareEnabled(!isScreenShareEnabled, { audio: true })}
      >
        🖥️
      </button>
      <button className="call-btn hangup" title="Leave call" onClick={onLeave}>
        📞
      </button>
    </div>
  );
}
