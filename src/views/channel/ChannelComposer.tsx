import { memo, useEffect, useRef, useState } from "react";
import { Loader2, Paperclip, SmilePlus, X } from "lucide-react";
import { colorFor } from "../../helpers/util";
import { UserName } from "../../components/User";
import { detectMention, type MentionCandidate } from "../../hooks/mentions";
import { useCommunityUserSearch } from "../../hooks/use-user-search";
import { EmojiPicker } from "../../components/EmojiPicker";
import type { Emoji } from "../../helpers/emoji";
import type { ConcordCommunity, ConcordChannelDraft, Media } from "@applesauce/concord";
import { useChannelDraft } from "../../hooks/use-channel-draft";
import { MissingChannelKeyError } from "@applesauce/concord";
import type { ReplyTarget } from "./types";

// The message composer. Owns its draft state locally so keystrokes re-render only
// this component, not the message list above it.
export const ChannelComposer = memo(function ChannelComposer({
  draft,
  channelName,
  channelPrivate,
  onClosePost,
  favorites,
  community,
  replyTo,
  onClearReply,
}: {
  draft: ConcordChannelDraft;
  channelName: string | undefined;
  channelPrivate: boolean;
  onClosePost?: () => void;
  favorites: Emoji[];
  community: ConcordCommunity;
  replyTo: ReplyTarget | null;
  onClearReply: () => void;
}) {
  const saved = useChannelDraft(draft);
  const text = saved.value.text;
  const files = saved.value.files ?? [];
  const isPost = Boolean(onClosePost);
  const activeReply = isPost ? undefined : replyTo ?? saved.value.replyTo;
  const missingTitle = isPost && !saved.value.subject?.trim();
  const titleRef = useRef<HTMLInputElement>(null);
  const { ready: draftReady, update: updateDraft } = saved;
  useEffect(() => {
    if (draftReady && replyTo && !isPost) updateDraft({ replyTo });
  }, [draftReady, isPost, replyTo, updateDraft]);
  useEffect(() => {
    if (isPost && draftReady) titleRef.current?.focus();
  }, [draftReady, isPost]);
  function setText(value: string | ((previous: string) => string)) {
    saved.update({ text: typeof value === "function" ? value(text) : value, emojis: favorites,
      replyTo: activeReply });
  }
  function setFiles(value: File[] | ((previous: readonly File[]) => File[])) {
    saved.update({ files: typeof value === "function" ? value(files) : value });
  }
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState("");
  const [upload, setUpload] = useState<Media.ConcordUploadProgress | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // What this send is busy with, so a slow encrypt or Blossom upload reads as
  // progress rather than a dead Send button. Once every file is up, the publish
  // itself is all that's left.
  const status = !sending
    ? null
    : upload && upload.done < upload.total
      ? `${upload.phase === "encrypting" ? "Encrypting" : "Uploading"} file ${upload.done + 1} of ${upload.total}…`
      : "Sending…";

  // @-mention menu: `mention` holds the active `@token` (query + `@` index);
  // `mentionIndex` is the keyboard-highlighted candidate.
  // Local-only: the community's shared member index, never the network.
  const { search: searchMentions } = useCommunityUserSearch(community);
  const [mention, setMention] = useState<{ query: string; start: number } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionResults = mention ? searchMentions(mention.query) : [];
  const mentionOpen = mention !== null && mentionResults.length > 0;
  const activeIndex = Math.min(mentionIndex, mentionResults.length - 1);

  // Re-detect the active `@token` from a value + caret and reset the highlight.
  function syncMention(value: string, caret: number) {
    setMention(detectMention(value, caret));
    setMentionIndex(0);
  }

  // Replace the `@token` with a `nostr:npub…` link; `messageRumor` adds the p tag.
  function insertMention(c: MentionCandidate) {
    if (!mention) return;
    const end = mention.start + 1 + mention.query.length;
    const insert = `nostr:${c.npub} `;
    const next = text.slice(0, mention.start) + insert + text.slice(end);
    setText(next);
    setMention(null);
    const caret = mention.start + insert.length;
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(caret, caret);
      }
    });
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
    setMention(null);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + insert.length;
      el.setSelectionRange(caret, caret);
    });
  }

  async function send() {
    const value = text.trim();
    if (sending || !saved.ready || missingTitle) return;
    if (!value && files.length === 0) return;
    setMention(null);
    setSending(true);
    setUpload(null);
    setSendError("");
    try {
      saved.update({ replyTo: activeReply, emojis: favorites });
      await saved.send({
        onUploadProgress: setUpload,
        ...(!isPost && { subject: undefined }),
      });
      onClearReply();
      onClosePost?.();
    } catch (err) {
      console.error("send failed", err);
      // A key can be rotated out from under an open composer, so name that case
      // rather than reporting it as a generic failure.
      setSendError(
        err instanceof MissingChannelKeyError
          ? "You no longer hold this channel's key, so your message can't be encrypted."
          : `Couldn't send: ${(err as Error).message}`,
      );
      // The SDK retains a failed draft and edits made while uploading.
    } finally {
      setUpload(null);
      setSending(false);
    }
  }

  const tools = (
    <>
    <input
      ref={fileInputRef}
      type="file"
      multiple
      hidden
      onChange={(e) => {
        setFiles((prev) => [...prev, ...Array.from(e.target.files ?? [])]);
        e.target.value = "";
      }}
    />
    <button type="button" className={isPost ? "btn btn-ghost min-h-11" : "btn btn-ghost btn-sm btn-circle"} title="Attach files" disabled={!saved.ready || (isPost && sending)} onClick={() => fileInputRef.current?.click()}>
      <Paperclip size={20} /> {isPost && "Attach files"}
    </button>
    <span className="relative inline-flex">
      <button type="button" className={isPost ? "btn btn-ghost min-h-11" : "btn btn-ghost btn-sm btn-circle"} title="Emoji" disabled={!saved.ready || (isPost && sending)} onClick={() => setPickerOpen((v) => !v)}>
        <SmilePlus size={20} /> {isPost && "Emoji"}
      </button>
      {pickerOpen && (
        <EmojiPicker
          favorites={favorites}
          align={isPost ? "left" : "right"}
          direction="up"
          onPick={(e) => insertEmoji(e)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </span>
    </>
  );

  return (
    <form
      className={isPost ? "flex-1 min-h-0 overflow-y-auto space-y-4 p-4 sm:p-6" : "px-4 pb-5 safe-bottombar shrink-0 max-sm:px-2"}
      aria-label={isPost ? "New post" : "Send message"}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {isPost && <h2 className="text-2xl font-semibold">New post</h2>}
      {saved.error && <div role="alert" className="text-error">{saved.error}</div>}
      {isPost && (
        <label className="block space-y-2 font-medium">
          <span>Title</span>
          <input ref={titleRef} className="input w-full min-h-11 text-base"
            required disabled={!saved.ready || sending}
            value={saved.value.subject ?? ""}
            onChange={(event) => saved.update({ subject: event.target.value })} />
        </label>
      )}
      {sendError && (
        <div className="flex justify-between items-center gap-2 bg-error/10 text-error rounded-t-lg px-4 py-1.5 text-[13px] -mb-1 max-sm:px-2">
          <span>{sendError}</span>
          <button type="button" className="btn btn-ghost btn-xs btn-circle" onClick={() => setSendError("")}>
            <X size={14} />
          </button>
        </div>
      )}
      {activeReply && (
        <div className="flex justify-between bg-base-200 rounded-t-lg px-4 py-1.5 text-[13px] text-base-content/60 -mb-1 max-sm:px-2">
          <span>
            Replying to <UserName pubkey={activeReply.author} />
          </span>
          <button type="button" className="btn btn-ghost btn-sm btn-circle" onClick={() => {
            saved.update({ replyTo: undefined });
            onClearReply();
          }}>
            <X size={16} />
          </button>
        </div>
      )}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 py-2">
          {files.map((f, i) => (
            <span
              className="inline-flex items-center gap-1.5 bg-base-200 rounded-md px-2 py-1 text-[13px] text-base-content max-w-[220px] overflow-hidden whitespace-nowrap text-ellipsis"
              key={i}
              title={f.name}
            >
              📎 {f.name}
              <button type="button" className={isPost ? "btn btn-ghost min-h-11 min-w-11" : "text-base-content/60 hover:text-error inline-flex"}
                aria-label={`Remove ${f.name}`} disabled={isPost && sending}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      {status && (
        <div className="flex items-center gap-2 px-1 py-2 text-[13px] text-base-content/60" role="status" aria-live="polite">
          <span className="loading loading-spinner loading-xs" />
          {status}
        </div>
      )}
      {isPost && <label htmlFor="forum-post-body" className="block font-medium">Body</label>}
      <div className={isPost
        ? "relative flex flex-wrap items-center gap-2 rounded-box border border-base-300 p-2"
        : "relative flex items-center gap-1 bg-base-200 rounded-lg px-4 max-sm:px-2"}>
        {!isPost && tools}
        {mentionOpen && (
          <ul
            className="absolute left-0 right-0 bottom-full mb-1.5 z-50 max-h-65 overflow-y-auto p-1.5 list-none bg-base-200 border border-base-300 rounded-box shadow-lg"
            role="listbox"
          >
            {mentionResults.map((c, i) => (
              <li key={c.pubkey} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left ${
                    i === activeIndex ? "bg-primary text-primary-content" : "hover:bg-base-300"
                  }`}
                  // Keep textarea focus so `onBlur`-free selection still works.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => insertMention(c)}
                >
                  {c.picture ? (
                    <img className="w-6 h-6 rounded-full shrink-0 object-cover" src={c.picture} alt="" />
                  ) : (
                    <span
                      className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold text-white uppercase"
                      style={{ background: colorFor(c.pubkey) }}
                    >
                      {c.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="truncate">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          id={isPost ? "forum-post-body" : undefined}
          disabled={!saved.ready || (isPost && sending)}
          rows={isPost ? 8 : 1}
          className={isPost ? "textarea w-full resize-y text-base" : "composer-textarea flex-1 min-w-0 bg-transparent border-0 outline-none resize-none py-3 max-h-50 leading-snug text-base-content"}
          placeholder={isPost ? undefined : `Message ${channelPrivate ? "🔒" : "#"}${channelName ?? ""}`}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onClick={(e) => syncMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0)}
          onKeyUp={(e) => {
            // Track caret moves (arrows/home/end) so the menu opens/closes as the
            // caret enters or leaves an @token — but don't fight menu-nav keys.
            if (!mentionOpen && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              syncMention(e.currentTarget.value, e.currentTarget.selectionStart ?? 0);
          }}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionResults.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                insertMention(mentionResults[activeIndex]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setMention(null);
                return;
              }
            }
            if (!isPost && e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        {isPost && tools}
        {!isPost && <button type="submit"
          className="btn btn-primary btn-sm max-[380px]:btn-square"
          disabled={sending || missingTitle || (!text.trim() && files.length === 0)}
        >
          {sending ? (
            // The line above the input carries the phase; keep the label steady so
            // the button doesn't resize on every step.
            <>
              <Loader2 size={14} className="animate-spin" />
              <span className="max-[380px]:hidden">Sending…</span>
            </>
          ) : (
            <>
              <span className="max-[380px]:hidden">Send</span>
              <span className="hidden max-[380px]:inline">Go</span>
            </>
          )}
        </button>}
      </div>
      {isPost && (
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn btn-ghost min-h-11 text-base" disabled={sending} onClick={onClosePost}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary min-h-11 text-base"
            disabled={!saved.ready || sending || missingTitle || (!text.trim() && files.length === 0)}>
            {sending ? "Publishing…" : "Publish post"}
          </button>
        </div>
      )}
    </form>
  );
});
