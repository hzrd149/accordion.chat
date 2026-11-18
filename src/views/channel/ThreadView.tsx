import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, CornerDownRight, Reply } from "lucide-react";
import { useCommunity } from "../../hooks/use-community";
import { useThread } from "../../chat/useMessages";
import { sendThreadReply as sendThreadReplyAction } from "../../chat/actions";
import { clockTime, colorFor, formatTime } from "../../helpers/util";
import { UserAvatar, UserName } from "../../components/User";
import { MessageContent } from "../../components/MessageContent";
import type { Emoji } from "../../helpers/emoji";
import type { ChatMessage } from "../../chat/fold";
import { displaySubject, getSubject } from "@applesauce/concord/helpers";
import { kinds } from "nostr-tools";
import { ThreadComposer } from "./ThreadComposer";

/** NIP-22 comment kind — the app's thread replies (rooted on chat messages). */
const COMMENT_KIND = 1111;

export function ThreadView({
  cid,
  channelId,
  root,
  canWrite,
  favorites,
  onBack,
  fullPage = false,
}: {
  cid: string;
  channelId: string;
  root: ChatMessage;
  canWrite: boolean;
  favorites: Emoji[];
  onBack?: () => void;
  fullPage?: boolean;
}) {
  const community = useCommunity(cid);
  const comments = useThread(community, channelId, root.id);
  const subject = getSubject(root.raw);
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (fullPage) headingRef.current?.focus({ preventScroll: true });
  }, [fullPage]);
  const [replyParent, setReplyParent] = useState<{ id: string; author: string; kind: number } | null>(null);
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  // No explicit target means replying to the thread root itself.
  const parent = replyParent ?? { id: root.id, author: root.author, kind: kinds.ChatMessage };

  async function sendThreadReply(text: string) {
    if (!community) return;
    await sendThreadReplyAction(community, channelId, parent, text, favorites);
    setReplyParent(null);
  }

  const composer = canWrite && community?.getChannel(channelId) && (
    <ThreadComposer
      key={parent.id}
      draft={community.getChannel(channelId)!.draft(parent.id)}
      fullPage={fullPage}
      replyingTo={replyParent?.author ?? null}
      favorites={favorites}
      onClear={() => setReplyParent(null)}
      onSend={sendThreadReply}
    />
  );

  return (
    <>
      {onBack && (
        <button className="shrink-0 flex items-center gap-1.5 px-4 py-2 text-base-content/60 text-[13px] hover:text-base-content"
          onClick={onBack}>
          <ArrowLeft size={14} /> All threads
        </button>
      )}
      {/* col-reverse keeps the scroll anchored to the newest comment: the browser
       * pins scrollTop to the reversed start, so new replies don't push the view.
       * The inner wrapper is one flex item, so its content still reads top-down. */}
      <div className={fullPage
        ? "flex-1 min-h-0 overflow-y-auto"
        : "flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col-reverse"}>
        <div>
          {fullPage && (
            <h1 ref={headingRef} tabIndex={-1} className="bg-base-200 px-4 py-4 break-words text-2xl font-semibold sm:px-8 sm:text-3xl">
              {displaySubject(subject ?? "").trim() || "Untitled post"}
            </h1>
          )}
          <div className={fullPage ? "flex gap-4 px-4 py-5 sm:px-8" : "flex gap-3 pb-3"}>
            <UserAvatar pubkey={root.author} className="w-10 h-10 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-semibold" style={{ color: colorFor(root.author) }}>
                  <UserName pubkey={root.author} />
                </span>
                <span className={fullPage ? "text-sm text-base-content/70" : "text-[11px] text-base-content/60"}>{formatTime(root.ms)}</span>
              </div>
              {root.deleted ? (
                <div className="text-base-content/60 italic">(message deleted)</div>
              ) : (
                <>
                  {!fullPage && subject !== undefined && <h3 className="break-words font-semibold">{displaySubject(subject)}</h3>}
                  <MessageContent text={root.edited ?? root.content} attachments={root.attachments} emojiTags={root.emojiTags} />
                </>
              )}
            </div>
          </div>

          <h2 className={fullPage
            ? "bg-base-300 px-4 py-2 text-lg font-semibold sm:px-8"
            : "flex items-center gap-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-base-content/50"}>
            <span className="shrink-0">
              {comments.length === 0 ? "No replies yet" : `${comments.length} ${comments.length === 1 ? "reply" : "replies"}`}
            </span>
            {!fullPage && <span className="h-px flex-1 bg-base-300" />}
          </h2>

          {comments.map((comment) => {
            // Nested replies stay in one flat list; the chip names the parent so the
            // shape of the conversation survives without indentation.
            const parentComment = comment.parent.kind === COMMENT_KIND ? byId.get(comment.parent.id) : undefined;
            const replying = replyParent?.id === comment.id;
            return (
              <div
                className={`group flex gap-3 ${fullPage
                  ? "flex-wrap items-start border-b border-base-300/60 px-4 py-4 odd:bg-base-200/50 sm:px-8"
                  : "-mx-2 rounded-lg px-2 py-1.5"}
                  ${replying ? "!bg-primary/10" : ""} ${!fullPage && !replying ? "hover:bg-base-300/50" : ""}`}
                key={comment.id}
              >
                <UserAvatar pubkey={comment.author} className="w-8 h-8 mt-0.5" />
                <div className="min-w-0 flex-1">
                  {parentComment && (
                    <div className={`flex items-center gap-1 mb-0.5 text-base-content/60 min-w-0 ${fullPage ? "text-sm" : "text-[11px]"}`}>
                      <CornerDownRight size={11} className="shrink-0" />
                      <span className="shrink-0">replying to</span>
                      <span className="font-medium truncate" style={{ color: colorFor(parentComment.author) }}>
                        <UserName pubkey={parentComment.author} />
                      </span>
                    </div>
                  )}
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className={fullPage ? "font-semibold" : "font-semibold text-sm"} style={{ color: colorFor(comment.author) }}>
                      <UserName pubkey={comment.author} />
                    </span>
                    <span className={fullPage ? "text-sm text-base-content/70" : "text-[11px] text-base-content/60"}>{fullPage ? formatTime(comment.ms) : clockTime(comment.ms)}</span>
                  </div>
                  {comment.deleted ? (
                    <div className="text-base-content/60 italic">(message deleted)</div>
                  ) : (
                    <MessageContent text={comment.content} attachments={[]} emojiTags={comment.emojiTags} />
                  )}
                </div>
                {canWrite && (
                  <button
                    className={fullPage
                      ? "btn btn-ghost min-h-11 text-base"
                      : "btn btn-ghost btn-xs btn-circle self-start shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"}
                    title="Reply to this comment"
                    onClick={() => setReplyParent({ id: comment.id, author: comment.author, kind: COMMENT_KIND })}
                  >
                    <Reply size={fullPage ? 18 : 14} /> {fullPage && "Reply"}
                  </button>
                )}
              </div>
            );
          })}
          {fullPage && composer}
        </div>
      </div>
      {!fullPage && composer}
    </>
  );
}

/** `replyingTo` is null when the reply targets the thread root — the common case,
 * where the placeholder alone is enough and the reply bar would just be noise. */
