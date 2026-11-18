import type { ConcordCommunity } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { use$ } from "applesauce-react/hooks";
import { useState } from "react";

export function ChannelPins({ community, channelId, onJump }: {
  community: ConcordCommunity; channelId: string; onJump: (id: string) => void;
}) {
  const pins = use$(() => community.getChannel(channelId)?.pins$, [community, channelId]) ?? [];
  const allowed = use$(() => community.can$(PERM.PIN_MESSAGES), [community]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Only show the section when there is something pinned (or an unpin error to report).
  if (!pins.length && !error) return null;
  return <details className="border-b border-base-300 px-4 py-2">
    <summary className="cursor-pointer text-sm">Pinned messages ({pins.length})</summary>
    <div className="max-h-60 overflow-y-auto">
      {pins.map((pin) => <div key={pin.rumor.id} className="flex items-center gap-2 py-2">
        <button className="text-sm text-left line-clamp-2 flex-1" onClick={() => onJump(pin.rumor.id)}>{pin.text}</button>
        {allowed && <button className="btn btn-ghost btn-xs" disabled={busy} onClick={() => {
          setBusy(true);
          setError("");
          void community.pins(channelId, { showBanned: true }).then((current) =>
            community.setPins(channelId, current.filter((item) => item.rumor.id !== pin.rumor.id).map((item) => item.entry)),
          ).catch((reason: unknown) => setError(String(reason))).finally(() => setBusy(false));
        }}>Unpin</button>}
      </div>)}
      {error && <p role="alert" className="text-error text-sm">{error}</p>}
    </div>
  </details>;
}
