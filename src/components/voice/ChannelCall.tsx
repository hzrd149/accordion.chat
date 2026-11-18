import { Loader2, Phone, ShieldQuestion, Volume2 } from "lucide-react";
import { useCall } from "./call-context";
import { UserAvatar } from "../User";
import { useChannelRoster } from "../../hooks/use-channel-roster";

/** Start (or return to) this channel's call. Present on every channel — the
 *  package models no voice/text split, so any channel can host one. */
export function ChannelCallButton({ cid, channelId, name }: { cid: string; channelId: string; name: string }) {
  const { active, pending, join } = useCall();
  const isActiveHere = active?.cid === cid && active?.channelId === channelId;
  const isPendingHere = pending?.cid === cid && pending?.channelId === channelId;
  if (isActiveHere || isPendingHere) return null;
  return (
    <button
      className="btn btn-ghost btn-sm btn-circle"
      title={`Start a call in #${name}`}
      onClick={() => join({ cid, channelId, channelName: name })}
    >
      <Volume2 size={18} />
    </button>
  );
}

/**
 * The call surface at the top of a channel's view. Every channel can host a call,
 * so this only materialises once one is actually happening: when you're in it (it
 * hosts the live stage the persistent VoiceRoom portals into), when you're joining,
 * or when someone else is already in. Starting a call from an empty channel goes
 * through the header's call button. Chat renders below it either way.
 */
export function VoiceCallPanel({ cid, channelId, name }: { cid: string; channelId: string; name: string }) {
  const { active, pending, error, join, setStageEl } = useCall();
  const { roster } = useChannelRoster(cid, channelId);
  const isActiveHere = active?.cid === cid && active?.channelId === channelId;
  const isPendingHere = pending?.cid === cid && pending?.channelId === channelId;

  // Host the persistent call surface here. `setStageEl` is the stable state
  // setter, so it's safe as a ref callback (node on mount, null on unmount).
  if (isActiveHere) return <div ref={setStageEl} />;
  if (!isPendingHere && roster.length === 0) return null;

  return (
    <div className="flex items-center gap-3 flex-wrap mx-auto mt-2.5 mb-1 w-[min(860px,calc(100%-24px))] bg-base-200 border border-base-300 rounded-xl px-3.5 py-2.5 max-sm:items-stretch">
      <div className="flex items-center gap-2.5 text-sm text-base-content flex-1 min-w-0">
        <Volume2 size={18} />
        <span>{roster.length ? `${roster.length} in the call` : "No one's in the call yet"}</span>
        <div className="flex items-center gap-1">
          {roster.map((r) =>
            r.author ? (
              <UserAvatar key={r.identity} pubkey={r.author} className="w-5 h-5" />
            ) : (
              <span key={r.identity} className="w-5 h-5 rounded-full bg-base-300 text-base-content/60 flex items-center justify-center">
                <ShieldQuestion size={14} />
              </span>
            ),
          )}
        </div>
      </div>
      <div className="flex items-center gap-2.5 max-sm:w-full max-sm:justify-end">
        {error && !isPendingHere && <span className="text-error text-[13px]">{error}</span>}
        {isPendingHere ? (
          <button className="btn btn-primary" disabled>
            <Loader2 className="animate-spin" size={16} /> Connecting…
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => join({ cid, channelId, channelName: name })}>
            <Phone size={16} /> Join call
          </button>
        )}
      </div>
    </div>
  );
}
