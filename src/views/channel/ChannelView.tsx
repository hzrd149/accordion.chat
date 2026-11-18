import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { ArrowLeft, Hash, Lock, MessageSquare, Plus, UserPlus, Users, Wrench } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useCommunity } from "../../hooks/use-community";
import { useMessages } from "../../chat/useMessages";
import { useMarkRead, useNewMessagesDivider } from "../../chat/useUnread";
import { useDevMode } from "../../hooks/use-dev-mode";
import { ForumPosts } from "../../components/ForumPosts";
import { ChannelPins } from "../../components/ChannelPins";
import { DirectInviteModal } from "../../components/DirectInviteModal";
import { DEFAULT_REACTIONS, type Emoji } from "../../helpers/emoji";
import { useFavoriteEmojis } from "../../hooks/use-favorite-emojis";
import type { ChannelMetadata } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { channelViewMode, getSubject, hasChannelKey } from "@applesauce/concord/helpers";
import { ChannelCallButton, VoiceCallPanel } from "../../components/voice/ChannelCall";
import { ChannelTimeline } from "./ChannelTimeline";
import { ChannelComposer } from "./ChannelComposer";
import { PrivateChannelDebugModal } from "./PrivateChannelDebugModal";
import { ThreadView } from "./ThreadView";
import type { ReplyTarget } from "./types";

/** How close to the bottom still counts as "following the conversation" (px). */
const BOTTOM_THRESHOLD_PX = 80;

const NO_CHANNELS: ChannelMetadata[] = [];

// The chat view is split into three independently-rendering pieces so a keystroke
// in the composer never re-renders the (potentially long) message list:
//   • ChannelView    — owns the message stream, scroll, and shared reply target.
//   • ChannelTimeline — memoized; re-renders only when the messages/groups change.
//   • ChannelComposer    — owns the draft text/files/sending/picker state locally.
export function ChannelView({
  cid,
  channelId,
  mobileNav,
  threadsOpen,
  membersOpen,
  onToggleThreads,
  onToggleMembers,
  onOpenThread,
}: {
  cid: string;
  channelId: string;
  mobileNav: React.ReactNode;
  threadsOpen: boolean;
  membersOpen: boolean;
  onToggleThreads: () => void;
  onToggleMembers: () => void;
  onOpenThread: (id: string) => void;
}) {
  const community = useCommunity(cid);
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const metadata = use$(community?.metadata$);
  const channels = use$(community?.channelViews$) ?? NO_CHANNELS;
  const dissolved = use$(community?.dissolved$) ?? false;
  const messages = useMessages(community, channelId);
  const channel = channels.find((c) => c.channel_id === channelId);
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { state } = useLocation();
  const jumpTargetId = searchParams.get("msg");
  const isForum = channelViewMode(channel) === "forum";
  const postId = isForum ? searchParams.get("post") : null;
  const post = postId ? messages.find((message) =>
    message.id === postId && !message.deleted && getSubject(message.raw) !== undefined
  ) : undefined;

  function navigateToPost(id: string | null) {
    if (id === null && state?.fromForumFeed) {
      navigate(-1);
      return;
    }
    setSearchParams((previous) => {
      const next = new URLSearchParams(previous);
      next.delete("msg");
      if (id) next.set("post", id);
      else next.delete("post");
      return next;
    }, { replace: id === null, state: id ? { fromForumFeed: true } : null });
  }
  const [newPostOpen, setNewPostOpen] = useState(false);
  const newPostButton = useRef<HTMLButtonElement>(null);
  const closeNewPost = () => {
    setNewPostOpen(false);
    newPostButton.current?.focus();
  };
  const [viewChoice, setViewChoice] = useState<{ jumpTargetId: string | null; timeline: boolean }>();
  const showTimeline = !isForum || (viewChoice?.jumpTargetId === jumpTargetId ? viewChoice.timeline : Boolean(jumpTargetId));
  const pendingJump = useRef<string | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const [directInviteOpen, setDirectInviteOpen] = useState(false);
  const [privateDebugOpen, setPrivateDebugOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const devMode = useDevMode();
  const canCreateInvite = use$(() => community?.can$(PERM.CREATE_INVITE), [community]) ?? false;
  const canManageChannels = use$(() => community?.can$(PERM.MANAGE_CHANNELS), [community]) ?? false;

  // Messages are folded oldest → newest, so the tail is the read cursor.
  const newestMs = messages.length ? messages[messages.length - 1].ms : 0;
  const dividerId = useNewMessagesDivider(pubkey, cid, channelId, messages);
  const [atBottom, setAtBottom] = useState(true);
  useMarkRead(pubkey, cid, channelId, newestMs, !showTimeline || atBottom);

  // Public channels are readable by every member; a private one only if we hold
  // its key. `hasChannelKey` is the package's own check against material — the
  // same rule its ChannelView.accessible flag exposes.
  const channelAccessible =
    !channel?.private || (community ? hasChannelKey(community.material, channelId) : false);
  const canDirectInvite = Boolean(community && channelAccessible && (channel?.private ? canManageChannels : canCreateInvite));

  // The user's NIP-30 favorite custom emojis (kind 10030 + referenced packs).
  const favorites = useFavoriteEmojis(pubkey, account?.signer);
  // Quick-react buttons: lead with the user's favorites, backfill with defaults.
  // Memoized so the reference stays stable and doesn't defeat ChannelTimeline's memo.
  const quickReactions = useMemo<(string | Emoji)[]>(
    () => [...favorites.slice(0, 3), ...DEFAULT_REACTIONS.slice(0, favorites.length >= 3 ? 2 : 3)],
    [favorites],
  );

  // Track whether the newest message is on screen. This gates both the
  // follow-the-conversation scroll below and the mark-read effect above, so
  // reading history is never interrupted by someone else posting.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // The list is column-reverse, so scrollTop is 0 at the newest message and
    // grows negative going back through history.
    const onScroll = () => setAtBottom(-el.scrollTop < BOTTOM_THRESHOLD_PX);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [postId, showTimeline]);

  // The list is column-reverse, so entering a channel already lands on the
  // newest message and stays there as messages arrive — no effect needed. Only
  // the unread divider (or a deep-linked `?msg=` target) has to be scrolled to.
  const positionedFor = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    const targetId = pendingJump.current ?? jumpTargetId;
    const positionKey = targetId ?? "";
    if (!pendingJump.current && positionedFor.current === positionKey) return;
    if (targetId) {
      const target = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(targetId)}"]`);
      if (!target) return;
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
      pendingJump.current = null;
    } else if (dividerId) {
      const target = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(dividerId)}"]`);
      if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 64;
    }
    positionedFor.current = jumpTargetId ?? "";
  }, [messages, dividerId, jumpTargetId, postId, showTimeline]);

  // Writing needs the channel's key as well as a live community: every channel
  // write path now throws MissingChannelKeyError for a private channel we can't
  // decrypt, so offering the composer there would only produce a failed send.
  const canWrite = !dissolved && channelAccessible;
  const composingPost = isForum && !showTimeline && newPostOpen;

  const jumpToMessage = useCallback((id: string) => {
    const scrollEl = scrollRef.current;
    const target = scrollEl?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    if (target) {
      target.scrollIntoView({ block: "center", behavior: "smooth" });
      target.focus({ preventScroll: true });
    } else if (!scrollEl) {
      setViewChoice({ jumpTargetId, timeline: true });
      pendingJump.current = id;
    }
  }, [jumpTargetId]);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
      <div className="h-12 safe-topbar flex items-center px-4 gap-2 border-b border-base-300 shadow-sm shrink-0">
        {mobileNav}
        <span className="inline-flex items-center text-base-content/60">
          {channel?.private ? <Lock size={20} /> : <Hash size={20} />}
        </span>
        <span className="font-semibold text-base-content">{channel?.name}</span>
        <span className="text-base-content/60 text-[13px] border-l border-base-300 pl-2 ml-1 max-md:hidden">{metadata?.description}</span>
        <div className="flex-1" />
        {channel && <ChannelCallButton cid={cid} channelId={channelId} name={channel.name} />}
        {devMode && channel?.private && (
          <button
            className="btn btn-ghost btn-sm btn-circle text-warning"
            title="Private channel debug"
            onClick={() => setPrivateDebugOpen(true)}
          >
            <Wrench size={18} />
          </button>
        )}
        <button
          className="btn btn-ghost btn-sm btn-circle"
          title={canDirectInvite ? "Direct invite" : "You do not have permission to invite here"}
          disabled={!canDirectInvite}
          onClick={() => setDirectInviteOpen(true)}
        >
          <UserPlus size={18} />
        </button>
        {!postId && <button className={`btn btn-ghost btn-sm btn-circle ${threadsOpen ? "btn-active" : ""}`} title="Threads" onClick={onToggleThreads}>
          <MessageSquare size={18} />
        </button>}
        {!postId && <button className={`btn btn-ghost btn-sm btn-circle ${membersOpen ? "btn-active" : ""}`} title="Members" onClick={onToggleMembers}>
          <Users size={18} />
        </button>}
      </div>
      {directInviteOpen && community && (
        <DirectInviteModal community={community} channel={channel} onClose={() => setDirectInviteOpen(false)} />
      )}
      {privateDebugOpen && community && channel?.private && (
        <PrivateChannelDebugModal
          community={community}
          channel={channel}
          channelId={channelId}
          myPubkey={pubkey}
          canCreateInvite={canCreateInvite}
          canManageChannels={canManageChannels}
          channelAccessible={channelAccessible}
          canDirectInvite={canDirectInvite}
          canWrite={canWrite}
          onClose={() => setPrivateDebugOpen(false)}
        />
      )}
      {channel && <VoiceCallPanel cid={cid} channelId={channelId} name={channel.name} />}
      {!postId && community && <ChannelPins key={channelId} community={community} channelId={channelId} onJump={jumpToMessage} />}
      {!postId && isForum && channelAccessible && (
        <div role="group" aria-label="Channel view" className="flex flex-wrap items-center gap-2 border-b border-base-300 px-4 py-2">
          <button type="button" className={`btn min-h-11 text-base ${!showTimeline ? "btn-active" : "btn-ghost"}`}
            aria-pressed={!showTimeline} onClick={() => setViewChoice({ jumpTargetId, timeline: false })}>Posts</button>
          <button type="button" className={`btn min-h-11 text-base ${showTimeline ? "btn-active" : "btn-ghost"}`}
            aria-pressed={showTimeline} onClick={() => {
              setNewPostOpen(false);
              setViewChoice({ jumpTargetId, timeline: true });
            }}>Timeline</button>
          {canWrite && !showTimeline && (
            <button ref={newPostButton} type="button" className="btn btn-primary ml-auto min-h-11 text-base"
              aria-expanded={composingPost} onClick={() => setNewPostOpen(true)}>
              <Plus size={20} aria-hidden="true" /> New post
            </button>
          )}
        </div>
      )}
      {isForum && channelAccessible && (!showTimeline || postId) && (
        <ForumPosts messages={messages} onOpenThread={navigateToPost} hidden={Boolean(postId) || (composingPost && canWrite)} />
      )}
      {postId ? (
        <>
          <div className="shrink-0 border-b border-base-300 px-4 py-2">
            <button type="button" className="btn btn-ghost min-h-11 text-base" onClick={() => navigateToPost(null)}>
              <ArrowLeft size={20} aria-hidden="true" /> All posts
            </button>
          </div>
          {post && channelAccessible ? (
            <ThreadView key={post.id} cid={cid} channelId={channelId} root={post}
              canWrite={canWrite} favorites={favorites} fullPage />
          ) : (
            <p role="status" className="p-6 text-base-content/70">This post is unavailable.</p>
          )}
        </>
      ) : (!isForum || !channelAccessible || showTimeline) && (
        <ChannelTimeline
          ref={scrollRef}
          messages={messages}
          channelName={channel?.name}
          ownerPubkey={community?.material.owner ?? ""}
          myPubkey={pubkey}
          canWrite={canWrite}
          community={community}
          channelId={channelId}
          dividerId={dividerId}
          favorites={favorites}
          quickReactions={quickReactions}
          onReply={setReplyTo}
          onJumpToMessage={jumpToMessage}
          onThread={(m) => onOpenThread(m.id)}
        />
      )}
      {!postId && canWrite && (showTimeline || composingPost) && community?.getChannel(channelId) && (
        <ChannelComposer
          key={`${pubkey}:${cid}:${channelId}`}
          draft={community.getChannel(channelId)!.draft()}
          channelName={channel?.name}
          channelPrivate={Boolean(channel?.private)}
          onClosePost={composingPost ? closeNewPost : undefined}
          favorites={favorites}
          community={community}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
        />
      )}
    </div>
  );
}
