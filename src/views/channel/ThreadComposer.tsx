import { useEffect, useRef, useState } from "react";
import { CornerDownRight, Loader2, Send, SmilePlus, X } from "lucide-react";
import { UserName } from "../../components/User";
import { EmojiPicker } from "../../components/EmojiPicker";
import type { Emoji } from "../../helpers/emoji";
import type { ConcordChannelDraft } from "@applesauce/concord";
import { useChannelDraft } from "../../hooks/use-channel-draft";

export function ThreadComposer({
  draft,
  replyingTo,
  fullPage,
  favorites,
  onClear,
  onSend,
}: {
  draft: ConcordChannelDraft;
  replyingTo: string | null;
  fullPage: boolean;
  favorites: Emoji[];
  onClear: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const saved = useChannelDraft(draft);
  const text = saved.value.text;
  const setText = (value: string | ((previous: string) => string)) =>
    saved.update({ text: typeof value === "function" ? value(text) : value });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (fullPage && replyingTo && saved.ready) textareaRef.current?.focus();
  }, [fullPage, replyingTo, saved.ready]);

  async function send() {
    const value = text.trim();
    if (!value || sending || !saved.ready) return;
    setSending(true);
    setError("");
    try {
      const customEmoji = favorites.some((emoji) => value.includes(`:${emoji.shortcode}:`));
      await saved.send(undefined, customEmoji ? onSend : undefined);
      if (fullPage && replyingTo && !customEmoji) onClear();
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  }

  // Insert an emoji (unicode or `:shortcode:`) at the caret, preserving focus.
  function insertEmoji(emoji: string | Emoji) {
    const insert = typeof emoji === "string" ? emoji : `:${emoji.shortcode}:`;
    const el = textareaRef.current;
    if (!el) {
      setText((t) => `${t}${insert}`);
      return;
    }
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = text.slice(0, start) + insert + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + insert.length;
      el.setSelectionRange(caret, caret);
    });
  }

  return (
    <div className={fullPage ? "bg-base-200 px-4 py-5 sm:px-8" : "shrink-0 px-4 pb-4 max-sm:px-2"}>
      {(error || saved.error) && <p role="alert" className="text-error text-sm">{error || saved.error}</p>}
      {replyingTo && (
        <div className={`flex items-center justify-between gap-2 px-1 pb-1 text-base-content/60 ${fullPage ? "text-base" : "text-[12px]"}`}>
          <span className="flex items-center gap-1 min-w-0">
            <CornerDownRight size={12} className="shrink-0" />
            <span className="truncate">
              Replying to <UserName pubkey={replyingTo} />
            </span>
          </span>
          <button className={fullPage ? "btn btn-ghost min-h-11 shrink-0" : "btn btn-ghost btn-xs btn-circle shrink-0"} title="Reply to the thread instead" onClick={onClear}>
            <X size={fullPage ? 18 : 14} /> {fullPage && "Cancel"}
          </button>
        </div>
      )}
      <div className={fullPage ? "flex flex-wrap items-center gap-2" : "flex items-end gap-2 bg-base-100 rounded-xl p-2"}>
        <span className="relative inline-flex shrink-0">
          <button className={fullPage ? "btn btn-ghost min-h-11" : "btn btn-ghost btn-sm btn-circle"} title="Emoji" disabled={!saved.ready} onClick={() => setPickerOpen((v) => !v)}>
            <SmilePlus size={18} /> {fullPage && "Emoji"}
          </button>
          {pickerOpen && (
            <EmojiPicker
              favorites={favorites}
              align="left"
              direction="up"
              onPick={(e) => insertEmoji(e)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </span>
        <textarea
          ref={textareaRef}
          className={fullPage ? "textarea order-first w-full resize-y bg-base-100 text-base" : "flex-1 min-w-0 min-h-9 max-h-35 resize-y bg-transparent outline-none border-0 leading-snug text-base-content"}
          disabled={!saved.ready}
          rows={fullPage ? 4 : 1}
          aria-label="Reply"
          placeholder={replyingTo ? "Write a reply…" : "Reply in thread"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (!fullPage && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className={fullPage ? "btn btn-primary ml-auto min-h-11 text-base" : "btn btn-primary btn-sm btn-circle shrink-0"}
          title={fullPage ? "Post reply" : "Send"}
          onClick={send}
          disabled={sending || !text.trim()}
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          {fullPage && (sending ? "Posting…" : "Post reply")}
        </button>
      </div>
    </div>
  );
}
