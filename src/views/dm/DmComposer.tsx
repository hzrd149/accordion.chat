import { useState } from "react";
import { use$ } from "applesauce-react/hooks";
import type { WrappedConversation } from "applesauce-extra/messages";
import { catchError, of } from "rxjs";
import { RefreshCw, Send } from "lucide-react";
import { useDisplayName } from "../../hooks/use-display-name";

export function DmComposer({
  peer,
  conversation,
  sending,
  retry,
  unavailable,
  error,
  onSend,
}: {
  peer: string;
  conversation: WrappedConversation;
  sending: boolean;
  retry: boolean;
  unavailable: boolean;
  error: string;
  onSend: (text: string) => Promise<boolean>;
}) {
  const peerName = useDisplayName(peer);
  const draft = use$(() => conversation.draft$.pipe(
    catchError((reason: unknown) => of(reason instanceof Error ? reason : new Error(String(reason)))),
  ), [conversation]);
  const busy = use$(conversation.client.busy$);
  // Keep keystrokes responsive while the SDK persists the encrypted draft.
  const [editedText, setEditedText] = useState<string>();
  const [draftError, setDraftError] = useState("");
  const text = editedText ?? (draft instanceof Error ? "" : draft?.content) ?? "";
  const disabled = sending || !!busy;
  function changeText(content: string) {
    setEditedText(content);
    setDraftError("");
    void conversation.setDraft({ content }).catch((reason: unknown) => setDraftError(`Could not save draft: ${String(reason)}`));
  }
  const message = error || draftError || (draft instanceof Error ? draft.message : "");
  return (
    <div className="shrink-0 safe-bottombar">
      <form className="p-3 border-t border-base-300 flex gap-2" onSubmit={(event) => {
        event.preventDefault();
        if (!disabled) void onSend(text).then((sent) => { if (sent) setEditedText(undefined); });
      }}>
        <input
          className="input input-bordered flex-1 min-w-0"
          value={text}
          onChange={(e) => changeText(e.target.value)}
          placeholder={`Message ${peerName}`}
          disabled={disabled || retry}
        />
        <button className="btn btn-primary shrink-0" type="submit" aria-label={retry ? "Retry send" : "Send message"} disabled={(!retry && !text.trim()) || disabled || unavailable}>
          {disabled ? <RefreshCw size={18} className="animate-spin" /> : retry ? "Retry send" : <Send size={18} />}
        </button>
      </form>
      {message && <div className="px-3 pb-3 text-error text-xs">{message}</div>}
    </div>
  );
}
