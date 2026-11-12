import type { FormEvent } from "react";
import { RefreshCw, Send } from "lucide-react";
import { useDisplayName } from "../../hooks/use-display-name";

export function DmComposer({
  peer,
  text,
  sending,
  error,
  onTextChange,
  onSubmit,
}: {
  peer: string;
  text: string;
  sending: boolean;
  error: string;
  onTextChange: (text: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  const peerName = useDisplayName(peer);
  return (
    <div className="shrink-0 safe-bottombar">
      <form className="p-3 border-t border-base-300 flex gap-2" onSubmit={onSubmit}>
        <input
          className="input input-bordered flex-1 min-w-0"
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder={`Message ${peerName}`}
          disabled={sending}
        />
        <button className="btn btn-primary shrink-0" type="submit" disabled={!text.trim() || sending}>
          {sending ? <RefreshCw size={18} className="animate-spin" /> : <Send size={18} />}
        </button>
      </form>
      {error && <div className="px-3 pb-3 text-error text-xs">{error}</div>}
    </div>
  );
}
