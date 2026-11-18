import { memo, useEffect, useRef, useState } from "react";
import { MessageSquare, MoreVertical, Pin, Pencil, Reply, SmilePlus, Trash2, X } from "lucide-react";
import { use$ } from "applesauce-react/hooks";
import { sendEditWithEmojis } from "../../chat/actions";
import { RawEventModal } from "../../components/modals";
import { clockTime, colorFor, formatTime } from "../../helpers/util";
import { UserAvatar, UserName } from "../../components/User";
import { MessageContent } from "../../components/MessageContent";
import { pinMessage } from "../../helpers/pins";
import { EmojiPicker } from "../../components/EmojiPicker";
import type { Emoji } from "../../helpers/emoji";
import type { ChatMessage } from "../../chat/fold";
import type { ConcordCommunity } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { displaySubject, getSubject } from "@applesauce/concord/helpers";
import type { ReplyTarget } from "./types";

/** Render a quick-reaction label: a unicode char, or a custom emoji image. */
function reactionLabel(r: string | Emoji) {
  return typeof r === "string" ? (
    r
  ) : (
    <img className="h-[1.35em] w-auto align-middle object-contain" src={r.url} alt={`:${r.shortcode}:`} loading="lazy" />
  );
}

// One message row. Memoized and holding its own edit / reaction-picker state, so
// editing or opening a picker on one message never re-renders its siblings.
// (The client rebuilds ChatMessage objects on every stream update, so memo can't
// yet skip rows on genuine data changes — but it does isolate them from parent
// re-renders driven by the reply bar or another row's picker.)
export const ChannelMessage = memo(function ChannelMessage({
  m,
  showHeader,
  replyPreview,
  ownerPubkey,
  myPubkey,
  canWrite,
  community,
  channelId,
  favorites,
  quickReactions,
  onReply,
  onJumpToMessage,
  onThread,
  devMode,
}: {
  m: ChatMessage;
  showHeader: boolean;
  replyPreview: string | undefined;
  ownerPubkey: string;
  myPubkey: string;
  canWrite: boolean;
  community: ConcordCommunity | undefined;
  channelId: string;
  favorites: Emoji[];
  quickReactions: (string | Emoji)[];
  onReply: (r: ReplyTarget) => void;
  onJumpToMessage: (id: string) => void;
  onThread: (m: ChatMessage) => void;
  /** Developer mode: exposes the per-message "View raw" debug dialog. */
  devMode: boolean;
}) {
  const subject = getSubject(m.raw);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const [actionError, setActionError] = useState("");
  const canModerate = use$(() => community?.canModerate$(m.author, PERM.MANAGE_MESSAGES), [community, m.author]) ?? false;
  const canDelete = !m.deleted && (m.author === myPubkey || canModerate);
  const canPinMessages = use$(() => community?.can$(PERM.PIN_MESSAGES), [community]) ?? false;
  const canPin = canWrite && canPinMessages && !m.deleted;
  const showMenu = canPin || devMode;
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const react = (reaction: string | Emoji) => community?.react(channelId, m.raw, reaction);
  async function deleteMessage() {
    setActionError("");
    try { await community?.deleteMessage(channelId, m.raw); }
    catch (error) { setActionError(String(error)); }
  }
  async function pin() {
    if (!community) return;
    setActionError("");
    try { await pinMessage(community, channelId, m.id); }
    catch (error) { setActionError(String(error)); }
  }

  useEffect(() => {
    return () => {
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
    };
  }, []);

  function closeLongPressTimer() {
    if (!longPressTimer.current) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }

  function isMobileActionsViewport() {
    return window.matchMedia("(max-width: 767px)").matches;
  }

  function startLongPress(e: React.PointerEvent<HTMLDivElement>) {
    if (!isMobileActionsViewport() || e.pointerType === "mouse") return;
    if ((e.target as Element).closest("button,a,input,textarea,select")) return;
    closeLongPressTimer();
    longPressTimer.current = setTimeout(() => {
      longPressTimer.current = null;
      setDrawerOpen(true);
    }, 450);
  }

  function actionAndClose(action: () => void) {
    action();
    setDrawerOpen(false);
  }

  async function saveEdit() {
    const value = editText.trim();
    setEditing(false);
    if (value) await sendEditWithEmojis(community, channelId, m.id, value, favorites);
  }

  return (
    <div
      data-msg-id={m.id}
      className={`group relative flex gap-3.5 px-4 hover:bg-base-200 focus-within:bg-base-200 max-sm:gap-2.5 max-sm:px-3 ${showHeader ? "py-0.5" : "py-px"}`}
      tabIndex={-1}
      onPointerDown={startLongPress}
      onPointerUp={closeLongPressTimer}
      onPointerCancel={closeLongPressTimer}
      onPointerLeave={closeLongPressTimer}
      onContextMenu={(e) => {
        if (!isMobileActionsViewport()) return;
        e.preventDefault();
        closeLongPressTimer();
        setDrawerOpen(true);
      }}
    >
      {showHeader ? (
        <UserAvatar pubkey={m.author} className="w-10 h-10 mt-0.5 max-sm:w-8 max-sm:h-8" />
      ) : (
        <div className="w-10 shrink-0 flex items-center justify-end max-sm:w-8">
          <span className="text-[10px] text-base-content/60 opacity-0 group-hover:opacity-100 whitespace-nowrap">{clockTime(m.ms)}</span>
        </div>
      )}
      <div className="min-w-0 flex-1">
        {actionError && <p role="alert" className="text-error text-xs">{actionError}</p>}
        {m.replyTo && (
          <button
            type="button"
            className="flex w-full items-center gap-1.5 text-left text-[13px] text-base-content/60 mb-0.5 min-w-0 hover:text-base-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 before:content-[''] before:shrink-0 before:w-6 before:h-2 before:border-l-2 before:border-t-2 before:border-base-300 before:rounded-tl-md before:ml-5 before:self-end"
            onClick={() => onJumpToMessage(m.replyTo!.id)}
            title="Jump to replied message"
          >
            <Reply size={14} className="shrink-0" />
            <span className="shrink-0"><UserName pubkey={m.replyTo.author} />:</span>
            <span className="truncate">{replyPreview}</span>
          </button>
        )}
        {showHeader && (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold" style={{ color: colorFor(m.author) }}>
              <UserName pubkey={m.author} />
            </span>
            <span className="text-[11px] text-base-content/60">{formatTime(m.ms)}</span>
            {m.author === ownerPubkey && <span className="badge badge-warning badge-sm">Owner</span>}
          </div>
        )}
        {editing ? (
          <input
            className="input input-bordered input-sm w-full"
            value={editText}
            autoFocus
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : m.deleted ? (
          <div className="text-base-content/60 italic">(message deleted)</div>
        ) : (
          <>
            {subject !== undefined && <h3 className="break-words font-semibold">{displaySubject(subject)}</h3>}
            <MessageContent text={m.edited ?? m.content} attachments={m.attachments} emojiTags={m.emojiTags} />
            {m.edited && <span className="text-[11px] text-base-content/60"> (edited)</span>}
          </>
        )}
        {m.reactions.length > 0 && (
          <div className="flex gap-1 mt-1 flex-wrap">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                className={`flex items-center gap-1 rounded-lg px-2 py-0.5 text-[13px] border ${
                  r.authors.includes(myPubkey) ? "border-primary bg-primary/15" : "border-base-300 bg-base-200 hover:border-base-content/40"
                }`}
                // Re-react: reconstruct the custom emoji from its URL, else the unicode content.
                onClick={() => react(r.url ? { shortcode: r.emoji.replace(/^:|:$/g, ""), url: r.url } : r.emoji)}
              >
                {r.url ? (
                  <img className="h-[1.35em] w-auto align-middle object-contain" src={r.url} alt={r.emoji} title={r.emoji} loading="lazy" />
                ) : (
                  r.emoji
                )}{" "}
                {r.count}
              </button>
            ))}
          </div>
        )}
        {m.threadReplyCount > 0 && (
          <button
            className="inline-flex items-center gap-1.5 mt-1.5 px-2 py-0.5 rounded-xl bg-primary/15 text-primary text-[13px] font-semibold hover:bg-primary/25"
            onClick={() => onThread(m)}
          >
            <MessageSquare size={14} /> {m.threadReplyCount} {m.threadReplyCount === 1 ? "reply" : "replies"}
          </button>
        )}
      </div>
      <div className="absolute -top-3 right-3 hidden group-hover:flex group-focus-within:flex bg-base-200 border border-base-300 rounded-md max-md:hidden">
        {canWrite && (
          <>
            {quickReactions.map((e) => (
              <button
                key={typeof e === "string" ? e : e.shortcode}
                className="btn btn-ghost btn-sm btn-circle"
                title={typeof e === "string" ? e : `:${e.shortcode}:`}
                onClick={() => react(e)}
              >
                {reactionLabel(e)}
              </button>
            ))}
            <span className="relative inline-flex">
              <button className="btn btn-ghost btn-sm btn-circle" title="React…" onClick={() => setPickerOpen((v) => !v)}>
                <SmilePlus size={16} />
              </button>
              {pickerOpen && (
                <EmojiPicker favorites={favorites} onPick={react} onClose={() => setPickerOpen(false)} />
              )}
            </span>
            <button className="btn btn-ghost btn-sm btn-circle" title="Reply" onClick={() => onReply({ id: m.id, author: m.author })}>
              <Reply size={16} />
            </button>
            <button className="btn btn-ghost btn-sm btn-circle" title="Reply in thread" onClick={() => onThread(m)}>
              <MessageSquare size={16} />
            </button>
            {m.author === myPubkey && !m.deleted && (
              <>
                <button
                  className="btn btn-ghost btn-sm btn-circle"
                  title="Edit"
                  onClick={() => {
                    setEditText(m.edited ?? m.content);
                    setEditing(true);
                  }}
                >
                  <Pencil size={16} />
                </button>
              </>
            )}
            {canDelete && <button className="btn btn-ghost btn-sm btn-circle" title="Delete" onClick={deleteMessage}>
              <Trash2 size={16} />
            </button>}
          </>
        )}
        {showMenu && (
        <span className="relative inline-flex">
          <button className="btn btn-ghost btn-sm btn-circle" title="More" onClick={() => setMenuOpen((v) => !v)}>
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <MessageMenu
              onClose={() => setMenuOpen(false)}
              onPin={canPin ? () => {
                setMenuOpen(false);
                void pin();
              } : undefined}
              onViewRaw={devMode ? () => {
                setMenuOpen(false);
                setRawOpen(true);
              } : undefined}
            />
          )}
        </span>
        )}
      </div>
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setDrawerOpen(false)}>
          <div className="w-full rounded-t-2xl bg-base-100 border-t border-base-300 p-4 safe-bottom-sheet shadow-2xl" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-semibold truncate" style={{ color: colorFor(m.author) }}>
                  <UserName pubkey={m.author} />
                </div>
                <div className="text-sm text-base-content/70 line-clamp-2">{m.deleted ? "(message deleted)" : m.edited ?? m.content}</div>
              </div>
              <button className="btn btn-ghost btn-sm btn-circle shrink-0" title="Close" onClick={() => setDrawerOpen(false)}>
                <X size={18} />
              </button>
            </div>
            {canWrite && (
              <>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {quickReactions.map((e) => (
                    <button
                      key={typeof e === "string" ? e : e.shortcode}
                      className="btn btn-ghost btn-sm btn-circle"
                      title={typeof e === "string" ? e : `:${e.shortcode}:`}
                      onClick={() => actionAndClose(() => react(e))}
                    >
                      {reactionLabel(e)}
                    </button>
                  ))}
                  <span className="relative inline-flex">
                    <button className="btn btn-ghost btn-sm btn-circle" title="React…" onClick={() => setPickerOpen((v) => !v)}>
                      <SmilePlus size={16} />
                    </button>
                    {pickerOpen && (
                      <EmojiPicker
                        favorites={favorites}
                        align="left"
                        direction="up"
                        onPick={(reaction) => actionAndClose(() => react(reaction))}
                        onClose={() => setPickerOpen(false)}
                      />
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <button className="btn btn-ghost justify-start" onClick={() => actionAndClose(() => onReply({ id: m.id, author: m.author }))}>
                    <Reply size={18} /> Reply
                  </button>
                  <button className="btn btn-ghost justify-start" onClick={() => actionAndClose(() => onThread(m))}>
                    <MessageSquare size={18} /> Reply in thread
                  </button>
                  {m.author === myPubkey && !m.deleted && (
                    <>
                      <button
                        className="btn btn-ghost justify-start"
                        onClick={() =>
                          actionAndClose(() => {
                            setEditText(m.edited ?? m.content);
                            setEditing(true);
                          })
                        }
                      >
                        <Pencil size={18} /> Edit
                      </button>
                    </>
                  )}
                  {canPin && <button className="btn btn-ghost justify-start" onClick={() => actionAndClose(() => void pin())}>
                    <Pin size={18} /> Pin message
                  </button>}
                  {canDelete && <button className="btn btn-ghost justify-start text-error" onClick={() => actionAndClose(() => void deleteMessage())}>
                    <Trash2 size={18} /> Delete
                  </button>}
                </div>
              </>
            )}
            {devMode && (
              <div className="mt-1 flex flex-col gap-1">
                <button className="btn btn-ghost justify-start" onClick={() => actionAndClose(() => setRawOpen(true))}>
                  <MoreVertical size={18} /> View raw
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      {rawOpen && <RawEventModal message={m} onClose={() => setRawOpen(false)} />}
    </div>
  );
});

// The per-message "more options" dropdown. Closes on outside-click or Escape.
// Each action renders only when its handler is supplied.
function MessageMenu({ onClose, onPin, onViewRaw }: { onClose: () => void; onPin?: () => void; onViewRaw?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="absolute top-full mt-1.5 right-0 z-50 min-w-[140px] flex flex-col p-1 bg-base-200 border border-base-300 rounded-box shadow-lg"
      ref={ref}
    >
      {onPin && (
        <button className="w-full flex items-center gap-2 text-left px-2.5 py-1.5 rounded text-sm hover:bg-base-300" onClick={onPin}>
          <Pin size={14} /> Pin message
        </button>
      )}
      {onViewRaw && (
        <button className="w-full text-left px-2.5 py-1.5 rounded text-sm hover:bg-base-300" onClick={onViewRaw}>
          View raw
        </button>
      )}
    </div>
  );
}
