import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate, useParams, useSearchParams } from "react-router";
import {
  ArrowLeft,
  AtSign,
  CornerDownRight,
  Hand,
  Hash,
  Inbox,
  Loader2,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  MoreVertical,
  Paperclip,
  Pencil,
  Phone,
  Plus,
  Reply,
  Send,
  Settings,
  ShieldQuestion,
  SmilePlus,
  Trash2,
  UserPlus,
  Users,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { accounts } from "../nostr";
import { ConcordProvider } from "../lib/context";
import { CallProvider } from "../components/voice/CallProvider";
import { useCall } from "../components/voice/call-context";
import { verifiedAuthorOf, type VoicePresenceFold } from "../voice/presence";
import { useVoiceEngine } from "../voice/registry";
import { useConcord } from "../lib/concord-context";
import { useCommunity } from "../hooks/use-community";
import { useInvites } from "../hooks/use-invites";
import { useMessages, useThread } from "../chat/useMessages";
import { useUnreadCounts, useMarkRead, useNewMessagesDivider, type ChannelUnread } from "../chat/useUnread";
import { useMentions } from "../chat/useMentions";
import { sendThreadReply as sendThreadReplyAction, sendEditWithEmojis } from "../chat/actions";
import { Login } from "./Login";
import {
  CreateChannelModal,
  CreateCommunityModal,
  InviteModal,
  JoinModal,
  Modal,
  RawEventModal,
} from "../components/modals";
import { clockTime, colorFor, formatTime, groupMessages } from "../lib/util";
import { UserAvatar, UserName } from "../components/User";
import { SettingsView } from "./settings";
import { DevView } from "./dev";
import { useDevMode } from "../lib/dev-mode";
import { InvitesView } from "./invites";
import { DmView } from "./dm";
import { ThemeToggle } from "../components/ThemeToggle";
import { ClientStatusRailIndicator, CommunityStatusDot } from "../components/ClientStatus";
import { CommunitySettingsView } from "./community-settings";
import { useDecryptedImage } from "../hooks/useDecryptedImage";
import { MessageContent } from "../components/MessageContent";
import { DirectInviteModal } from "../components/DirectInviteModal";
import { useMentionCandidates, useMentionSearch, detectMention, type MentionCandidate } from "../hooks/mentions";
import { EmojiPicker } from "../components/EmojiPicker";
import { DEFAULT_REACTIONS, useFavoriteEmojis, type Emoji } from "../lib/emoji";
import { getMentionsLastRead, markMentionsRead, useReadState } from "../lib/read-state";
import type { ChatMessage } from "../chat/fold";
import type { ChannelMetadata, CommunityState, Role, ConcordCommunity, Storage } from "applesauce-concord";
import { PERM } from "applesauce-concord";
import { kinds } from "nostr-tools";

/** How close to the bottom still counts as "following the conversation" (px). */
const BOTTOM_THRESHOLD_PX = 80;

/** NIP-22 comment kind — the app's thread replies (rooted on chat messages). */
const COMMENT_KIND = 1111;

export function App() {
  const account = useActiveAccount();
  if (!account) return <Login />;
  return (
    <ConcordProvider>
      {() => (
        <CallProvider>
          <Routes>
            <Route path="/" element={<Shell />} />
            {/* Where a minted invite link points (CORD-05 §2:
                `<base>/invite/<naddr>#<token>`). Without this the catch-all below
                would bounce a shared link to "/" and silently drop the token. */}
            <Route path="/invite/:naddr" element={<Shell />} />
            <Route path="/dm" element={<Shell />} />
            <Route path="/dm/:peerPubkey" element={<Shell />} />
            <Route path="/invites" element={<Shell />} />
            <Route path="/settings" element={<Shell />} />
            <Route path="/settings/:page" element={<Shell />} />
            <Route path="/dev" element={<Shell />} />
            <Route path="/dev/:page" element={<Shell />} />
            <Route path="/c/:cid" element={<Shell />} />
            <Route path="/c/:cid/settings" element={<Shell />} />
            <Route path="/c/:cid/settings/:page" element={<Shell />} />
            <Route path="/c/:cid/mentions" element={<Shell />} />
            <Route path="/c/:cid/:channelId" element={<Shell />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </CallProvider>
      )}
    </ConcordProvider>
  );
}

/** Overlay names carried in the `?modal=` query param. */
type ModalName = "create" | "join" | "channel" | "invite" | "addMenu";

// Stable empty fallback so `communities` keeps a constant identity while the
// stream is still empty — otherwise a fresh `[]` each render would retrigger the
// auto-select effect below on every render.
const NO_COMMUNITIES: CommunityState[] = [];

function Shell() {
  const client = useConcord();
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const communities = use$(client.communities$) ?? NO_COMMUNITIES;
  const navigate = useNavigate();
  const { cid: cidParam, channelId: channelParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // All navigation state lives in the URL: community/channel in the path,
  // transient overlays (modals + settings) in the query string.
  const selectedCid = cidParam ?? null;
  const selectedChannel = channelParam ?? null;
  const modal = searchParams.get("modal") as ModalName | null;
  // Settings, community settings, and Direct Invites (CORD-05 §6) are their own
  // routes rendered in the main area (the community rail stays put), not
  // full-screen overlays.
  const onInvites = useLocation().pathname === "/invites";
  const dmRootMatch = useMatch("/dm");
  const dmPeerMatch = useMatch("/dm/:peerPubkey");
  const onDm = Boolean(dmRootMatch || dmPeerMatch);
  // A followed invite link. The unlock token rides the URL *fragment*, which no
  // router param carries, so hand the join flow the whole href rather than the
  // :naddr — the bundle is useless without the token.
  const inviteMatch = useMatch("/invite/:naddr");
  const settingsMatch = useMatch("/settings/:page");
  const settingsRootMatch = useMatch("/settings");
  const onSettings = Boolean(settingsMatch || settingsRootMatch);
  const settingsPage = settingsMatch?.params.page ?? "profile";
  const adminMatch = useMatch("/c/:cid/settings/:page");
  const adminRootMatch = useMatch("/c/:cid/settings");
  const onCommunitySettings = Boolean(adminMatch || adminRootMatch);
  const communitySettingsPage = adminMatch?.params.page ?? "overview";
  const mentionsMatch = useMatch("/c/:cid/mentions");
  const onMentions = Boolean(mentionsMatch);
  const devMode = useDevMode();
  const devMatch = useMatch("/dev/:page");
  const devRootMatch = useMatch("/dev");
  const onDev = Boolean(devMatch || devRootMatch);
  const devPage = devMatch?.params.page ?? "crypto-history";
  const { count: inviteCount } = useInvites();

  function setParam(key: string, value: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === null) next.delete(key);
        else next.set(key, value);
        return next;
      },
      { replace: true },
    );
  }
  const setModal = (m: ModalName | null) => setParam("modal", m);

  // Mobile off-canvas drawers (ignored by CSS above the tablet breakpoint).
  const [navOpen, setNavOpen] = useState(false);
  // The right-hand side panel: opened with either the member roster or the
  // channel's threads, closed via its own close button (or the mobile toggle).
  type PanelMode = null | "members" | "threads";
  const [panelMode, setPanelMode] = useState<PanelMode>(null);
  const [threadRootId, setThreadRootId] = useState<string | null>(null);
  const closeDrawers = () => {
    setNavOpen(false);
    setPanelMode(null);
  };

  const toggleMembers = () => {
    setPanelMode((prev) => (prev === "members" ? null : "members"));
    setThreadRootId(null);
  };
  const toggleThreads = () => {
    setPanelMode((prev) => (prev === "threads" ? null : "threads"));
    setThreadRootId(null);
  };
  const openThread = (id: string) => {
    setThreadRootId(id);
    setPanelMode("threads");
  };

  // Reset the active thread when the channel (or community) changes — a root
  // id from the old channel won't resolve in the new one. Keep the panel itself
  // open so a members/threads view survives navigation.
  const [prevChannel, setPrevChannel] = useState(selectedChannel);
  const [prevCid, setPrevCid] = useState(selectedCid);
  if (selectedChannel !== prevChannel || selectedCid !== prevCid) {
    setPrevChannel(selectedChannel);
    setPrevCid(selectedCid);
    setThreadRootId(null);
  }

  // The user's NIP-30 favorite custom emojis — feeds the thread composer in
  // the side panel.
  const favorites = useFavoriteEmojis(pubkey, account?.signer);

  // Auto-select a community and channel only when the URL has not already made
  // a choice. Deep links may point at communities/channels that are still being
  // restored from the local mirror or relay list, so don't replace them just
  // because the current fold has not surfaced them yet.
  const activeState = communities.find((c) => c.material.community_id === selectedCid);
  useEffect(() => {
    // Don't auto-jump into a community from the invites/settings routes — only
    // from root.
    if (communities.length > 0 && !selectedCid && !onDm && !onInvites && !onSettings && !onDev) {
      navigate(`/c/${communities[0].material.community_id}`, { replace: true });
    }
  }, [communities, selectedCid, onDm, onInvites, onSettings, onDev, navigate]);

  useEffect(() => {
    if (!activeState || onCommunitySettings || onMentions) return;
    const channels = activeState.channels;
    if (channels.length && !selectedChannel) {
      navigate(`/c/${activeState.material.community_id}/${channels[0].channel_id}`, { replace: true });
    }
  }, [activeState, selectedChannel, onCommunitySettings, onMentions, navigate]);

  return (
    <div className="flex h-screen overflow-hidden max-md:h-[100dvh]">
      {(navOpen || panelMode) && (
        <div className="fixed inset-0 z-[35] bg-black/50 md:hidden" onClick={closeDrawers} />
      )}

      {/* Community rail */}
      <div
        className={`w-18 bg-base-300 flex flex-col items-center py-3 gap-2 overflow-y-auto shrink-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:transition-transform ${
          navOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        }`}
      >
        {communities.map((c) => (
          <RailIcon
            key={c.material.community_id}
            state={c}
            active={c.material.community_id === selectedCid}
            onClick={() => {
              navigate(`/c/${c.material.community_id}`);
              setNavOpen(false);
            }}
          />
        ))}
        <div className="w-8 h-0.5 bg-base-content/10 rounded-full shrink-0" />
        <button
          className="w-12 h-12 shrink-0 rounded-3xl bg-base-200 flex items-center justify-center text-success overflow-hidden transition-all hover:rounded-2xl hover:bg-primary hover:text-primary-content"
          title="Add a community"
          onClick={() => setModal("addMenu")}
        >
          <Plus size={24} />
        </button>
        <div className="mt-auto shrink-0">
          <ClientStatusRailIndicator />
        </div>
        <button
          className={`w-12 h-12 shrink-0 bg-base-200 flex items-center justify-center overflow-hidden transition-all hover:rounded-2xl hover:bg-primary hover:text-primary-content ${
            onDm ? "rounded-2xl bg-primary text-primary-content" : "rounded-3xl text-base-content/60"
          }`}
          title="Direct messages"
          onClick={() => {
            navigate("/dm");
            setNavOpen(false);
          }}
        >
          <MessageSquare size={22} />
        </button>
        <div className="relative w-12 h-12 shrink-0">
          <button
            className={`w-full h-full bg-base-200 flex items-center justify-center overflow-hidden transition-all hover:rounded-2xl hover:bg-primary hover:text-primary-content ${
              onInvites ? "rounded-2xl bg-primary text-primary-content" : "rounded-3xl text-base-content/60"
            }`}
            title={inviteCount > 0 ? `${inviteCount} pending invite${inviteCount === 1 ? "" : "s"}` : "Invites"}
            onClick={() => {
              navigate("/invites");
              setNavOpen(false);
            }}
          >
            <Inbox size={22} />
          </button>
          {inviteCount > 0 && (
            <span className="absolute -top-1 -right-1 min-w-5 h-5 px-1 rounded-full bg-primary text-primary-content text-[11px] font-bold flex items-center justify-center pointer-events-none">
              {inviteCount > 99 ? "99+" : inviteCount}
            </span>
          )}
        </div>
        {devMode && (
          <button
            className={`w-12 h-12 shrink-0 bg-base-200 flex items-center justify-center overflow-hidden transition-all hover:rounded-2xl hover:bg-primary hover:text-primary-content ${
              onDev ? "rounded-2xl bg-primary text-primary-content" : "rounded-3xl text-base-content/60"
            }`}
            title="Developer tools"
            onClick={() => {
              navigate("/dev");
              setNavOpen(false);
            }}
          >
            <Wrench size={22} />
          </button>
        )}
        <button
          className={`w-12 h-12 shrink-0 bg-base-200 flex items-center justify-center overflow-hidden transition-all hover:rounded-2xl hover:bg-primary hover:text-primary-content ${
            onSettings ? "rounded-2xl bg-primary text-primary-content" : "rounded-3xl text-base-content/60"
          }`}
          title="Settings"
          onClick={() => {
            navigate("/settings");
            setNavOpen(false);
          }}
        >
          <Settings size={22} />
        </button>
      </div>

      {onDm ? (
        <DmView
          mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
          mobileNavOpen={navOpen}
          onOpenMobileNav={() => setNavOpen(true)}
          onCloseMobileNav={() => setNavOpen(false)}
        />
      ) : onInvites ? (
        <InvitesView mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />} />
      ) : onSettings ? (
        <SettingsView
          page={settingsPage}
          mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
          onSelectPage={(p) => navigate(`/settings/${p}`)}
        />
      ) : onDev ? (
        <DevView
          page={devPage}
          mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
          onSelectPage={(p) => navigate(`/dev/${p}`)}
        />
      ) : activeState ? (
        onCommunitySettings ? (
          <CommunitySettingsView
            cid={activeState.material.community_id}
            page={communitySettingsPage}
            mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
            onSelectPage={(p) => navigate(`/c/${activeState.material.community_id}/settings/${p}`)}
            onClose={() => navigate(`/c/${activeState.material.community_id}`)}
          />
        ) : (
        <>
          <div
            className={`md:contents max-md:fixed max-md:inset-y-0 max-md:left-18 max-md:z-40 max-md:transition-transform ${
              navOpen ? "max-md:translate-x-0" : "max-md:-translate-x-[calc(100%+4.5rem)]"
            }`}
          >
            <Sidebar
              state={activeState}
              selectedChannel={selectedChannel}
              mentionsActive={onMentions}
              onSelectChannel={(id) => {
                navigate(`/c/${activeState.material.community_id}/${id}`);
                setNavOpen(false);
              }}
              onSelectMentions={() => {
                navigate(`/c/${activeState.material.community_id}/mentions`);
                setNavOpen(false);
              }}
              onNewChannel={() => setModal("channel")}
              onInvite={() => setModal("invite")}
              onSettings={() => navigate(`/c/${activeState.material.community_id}/settings`)}
            />
          </div>
          {onMentions ? (
            <MentionsView
              cid={activeState.material.community_id}
              state={activeState}
              mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
              onOpenChannel={(channelId, msgId) => {
                const url = msgId
                  ? `/c/${activeState.material.community_id}/${channelId}?msg=${msgId}`
                  : `/c/${activeState.material.community_id}/${channelId}`;
                navigate(url);
                setNavOpen(false);
              }}
            />
          ) : selectedChannel ? (
            <ChatView
              cid={activeState.material.community_id}
              channelId={selectedChannel}
              state={activeState}
              mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
              threadsOpen={panelMode === "threads"}
              membersOpen={panelMode === "members"}
              onToggleThreads={toggleThreads}
              onToggleMembers={toggleMembers}
              onOpenThread={openThread}
            />
          ) : (
            <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
              <div className="flex-1 flex flex-col items-center justify-center text-base-content/60 gap-2 text-center p-10">
                <div className="flex items-center justify-center"><MessageSquare size={48} /></div>
                <div>Select or create a channel to start chatting.</div>
              </div>
            </div>
          )}
          {panelMode && (
            <SidePanel
              mode={panelMode}
              state={activeState}
              cid={activeState.material.community_id}
              channelId={selectedChannel}
              threadRootId={threadRootId}
              favorites={favorites}
              canWrite={!activeState.dissolved}
              onOpenThread={openThread}
              onCloseThread={() => setThreadRootId(null)}
              onClose={() => setPanelMode(null)}
            />
          )}
        </>
        )
      ) : (
        <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
          <div className="h-12 flex items-center px-4 border-b border-base-300 shadow-sm shrink-0 md:hidden">
            <MobileNavButton onClick={() => setNavOpen(true)} />
          </div>
          <div className="flex-1 flex flex-col items-center justify-center text-base-content/60 gap-2 text-center p-10">
            <div className="text-5xl leading-none" aria-hidden="true">🪗</div>
            <h2 className="text-2xl font-bold text-base-content m-0">Welcome to Accordion</h2>
            <div>Create your own community or join one with an invite link.</div>
            <div className="flex flex-wrap justify-center gap-3 mt-3">
              <button className="btn btn-primary" onClick={() => setModal("create")}>
                Create a community
              </button>
              <button className="btn btn-ghost" onClick={() => setModal("join")}>
                Join with a link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {modal === "addMenu" && (
        <Modal onClose={() => setModal(null)}>
          <h2 className="text-lg font-bold mb-4">Add a community</h2>
          <button className="btn btn-primary btn-block mb-2.5" onClick={() => setModal("create")}>
            Create my own
          </button>
          <button className="btn btn-ghost btn-block" onClick={() => setModal("join")}>
            Join with an invite link
          </button>
        </Modal>
      )}
      {modal === "create" && (
        <CreateCommunityModal
          onClose={() => setModal(null)}
          onCreated={(id) => navigate(`/c/${id}`)}
        />
      )}
      {(modal === "join" || inviteMatch) && (
        <JoinModal
          initialLink={inviteMatch ? window.location.href : ""}
          onClose={() => (inviteMatch ? navigate("/") : setModal(null))}
          onJoined={(id) => navigate(`/c/${id}`)}
        />
      )}
      {modal === "channel" && activeState && (
        <CreateChannelModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
      )}
      {modal === "invite" && activeState && (
        <InviteModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
      )}
    </div>
  );
}

function MobileNavButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="btn btn-ghost btn-sm btn-circle shrink-0 md:hidden" title="Menu" onClick={onClick}>
      <Menu size={22} />
    </button>
  );
}

function RailIcon({ state, active, onClick }: { state: CommunityState; active: boolean; onClick: () => void }) {
  const name = state.metadata?.name ?? state.material.name;
  const iconUrl = useDecryptedImage(state.metadata?.icon);
  return (
    <div className="relative w-12 h-12 shrink-0">
      <button
        className={`w-full h-full relative overflow-hidden flex items-center justify-center font-semibold text-base-content text-lg bg-base-200 transition-all hover:rounded-2xl hover:bg-primary hover:text-primary-content ${
          active
            ? "rounded-2xl before:content-[''] before:absolute before:-left-4 before:w-2 before:h-10 before:rounded-r before:bg-base-content"
            : "rounded-3xl"
        }`}
        title={name}
        onClick={onClick}
      >
        {iconUrl ? <img className="w-full h-full object-cover" src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
      </button>
      <CommunityStatusDot cid={state.material.community_id} />
    </div>
  );
}

// One text-channel row. An unread channel reads at full contrast and semibold
// (an unselected read one is dimmed), with the count as a trailing pill —
// tinted `error` when something in it mentions you, so a mention is findable
// without reading every badge.
function ChannelRow({
  channel,
  selected,
  unread,
  onSelect,
}: {
  channel: ChannelMetadata;
  selected: boolean;
  unread: ChannelUnread | undefined;
  onSelect: () => void;
}) {
  const count = unread?.count ?? 0;
  const has = count > 0;
  return (
    <button
      data-channel-row={channel.name}
      className={`flex items-center gap-1.5 px-2 py-1.5 rounded w-full text-left mb-px ${
        selected
          ? "bg-base-300 text-base-content font-medium"
          : has
            ? "text-base-content font-semibold hover:bg-base-300"
            : "text-base-content/60 font-medium hover:bg-base-300 hover:text-base-content"
      }`}
      onClick={onSelect}
    >
      <span className="inline-flex items-center text-base-content/60">
        {channel.private ? <Lock size={16} /> : <Hash size={16} />}
      </span>
      <span className="truncate">{channel.name}</span>
      {has && (
        <span
          data-unread-badge
          data-mention={unread?.mention ? "true" : "false"}
          className={`ml-auto shrink-0 min-w-5 h-5 px-1 rounded-full text-[11px] font-bold flex items-center justify-center pointer-events-none ${
            unread?.mention ? "bg-error text-error-content" : "bg-base-content/20 text-base-content"
          }`}
          title={`${count} unread message${count === 1 ? "" : "s"}${unread?.mention ? ", mentions you" : ""}`}
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </button>
  );
}

function Sidebar({
  state,
  selectedChannel,
  mentionsActive,
  onSelectChannel,
  onSelectMentions,
  onNewChannel,
  onInvite,
  onSettings,
}: {
  state: CommunityState;
  selectedChannel: string | null;
  mentionsActive: boolean;
  onSelectChannel: (id: string) => void;
  onSelectMentions: () => void;
  onNewChannel: () => void;
  onInvite: () => void;
  onSettings: () => void;
}) {
  const community = useCommunity(state.material.community_id);
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const canManageChannels = community?.canDo(PERM.MANAGE_CHANNELS) ?? false;
  const canInvite = community?.canDo(PERM.CREATE_INVITE) ?? false;
  const bannerUrl = useDecryptedImage(state.metadata?.banner);
  const readState = useReadState(pubkey);

  // Only text channels carry chat, so only they can be unread — and counting a
  // voice channel would open a rumor store (and its IndexedDB database) for a
  // plane that never holds messages.
  const textChannelIds = useMemo(
    () => state.channels.filter((c) => !c.voice).map((c) => c.channel_id),
    [state.channels],
  );
  const unread = useUnreadCounts(
    community,
    state.material.community_id,
    textChannelIds,
    pubkey,
  );

  // Mentions badge: count mentions newer than the mentions cursor. Only text
  // channels the user can read are scanned (public + held private channels).
  const readableChannelIds = useMemo(
    () =>
      state.channels
        .filter((c) => !c.voice && (!c.private || community?.material.channels.some((mc) => mc.id === c.channel_id)))
        .map((c) => c.channel_id),
    [state.channels, community],
  );
  const mentionRows = useMentions(community, state.material.community_id, readableChannelIds, pubkey);
  const mentionsLastRead = getMentionsLastRead(readState, state.material.community_id);
  const mentionUnread = useMemo(
    () => mentionRows.filter((m) => m.ms > mentionsLastRead).length,
    [mentionRows, mentionsLastRead],
  );

  return (
    <div className="w-60 bg-base-200 flex flex-col shrink-0 max-md:h-full">
      {bannerUrl && <div className="h-25 bg-cover bg-center shrink-0" style={{ backgroundImage: `url(${bannerUrl})` }} />}
      <div
        className={`h-12 px-4 flex items-center justify-between border-b border-base-300 shadow-sm font-semibold text-base-content shrink-0 ${
          bannerUrl ? "-mt-5 bg-gradient-to-b from-transparent to-base-200" : ""
        }`}
      >
        <span className="truncate" title={state.material.community_id}>{state.metadata?.name ?? state.material.name}</span>
        <div className="flex items-center gap-1 shrink-0">
          <button className="btn btn-ghost btn-sm btn-circle" title="Community settings" onClick={onSettings}>
            <Settings size={18} />
          </button>
        </div>
      </div>
      {state.dissolved && (
        <div className="text-error text-sm p-3">
          This community has been dissolved. It is now read-only.
        </div>
      )}
      <div className="flex-1 overflow-y-auto p-2">
        <button
          data-mentions-row
          className={`flex items-center gap-1.5 px-2 py-1.5 rounded w-full text-left mb-1 ${
            mentionsActive
              ? "bg-base-300 text-base-content font-medium"
              : mentionUnread > 0
                ? "text-base-content font-semibold hover:bg-base-300"
                : "text-base-content/60 font-medium hover:bg-base-300 hover:text-base-content"
          }`}
          onClick={onSelectMentions}
        >
          <span className="inline-flex items-center text-base-content/60"><AtSign size={16} /></span>
          <span>Mentions</span>
          {mentionUnread > 0 && (
            <span
              className="ml-auto shrink-0 min-w-5 h-5 px-1 rounded-full text-[11px] font-bold flex items-center justify-center pointer-events-none bg-error text-error-content"
              title={`${mentionUnread} unread mention${mentionUnread === 1 ? "" : "s"}`}
            >
              {mentionUnread > 99 ? "99+" : mentionUnread}
            </span>
          )}
        </button>
        <div className="flex justify-between items-center text-[11px] uppercase text-base-content/60 font-semibold pt-4 px-2 pb-1">
          <span>Channels</span>
          {canManageChannels && !state.dissolved && (
            <button className="btn btn-ghost btn-xs btn-circle" title="Create channel" onClick={onNewChannel}>
              <Plus size={16} />
            </button>
          )}
        </div>
        {state.channels.map((ch) =>
          ch.voice ? (
            <VoiceChannelRow
              key={ch.channel_id}
              cid={state.material.community_id}
              channelId={ch.channel_id}
              name={ch.name}
              selected={ch.channel_id === selectedChannel}
              onSelect={() => onSelectChannel(ch.channel_id)}
            />
          ) : (
            <ChannelRow
              key={ch.channel_id}
              channel={ch}
              selected={ch.channel_id === selectedChannel}
              unread={unread[ch.channel_id]}
              onSelect={() => onSelectChannel(ch.channel_id)}
            />
          ),
        )}
        {canInvite && !state.dissolved && (
          <button
            className="flex items-center gap-1.5 px-2 py-1.5 rounded w-full text-left font-medium mt-3 text-success hover:bg-base-300"
            onClick={onInvite}
          >
            <span className="inline-flex items-center"><UserPlus size={16} /></span>
            <span>Invite people</span>
          </button>
        )}
      </div>
      <div className="h-13 bg-base-300 flex items-center px-2 gap-2 shrink-0">
        <UserAvatar pubkey={account?.pubkey ?? ""} />
        <div className="flex-1 overflow-hidden">
          <div className="text-sm font-semibold text-base-content truncate">
            <UserName pubkey={account?.pubkey ?? ""} />
          </div>
          <div className="text-[11px] text-base-content/60 truncate">{account?.pubkey === state.material.owner ? "Owner" : "Member"}</div>
        </div>
        <ThemeToggle />
        <button
          className="btn btn-ghost btn-sm btn-circle"
          title="Sign out"
          onClick={() => {
            if (account) accounts.removeAccount(account);
          }}
        >
          <LogOut size={18} />
        </button>
      </div>
    </div>
  );
}

const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map<string, string[]>() };

/** Roster entries (identity → verified author) for a channel's live call (§4). */
function useRoster(cid: string, channelId: string) {
  const engine = useVoiceEngine(cid);
  const fold = use$(() => (engine ? engine.getVoicePresence$(channelId) : undefined), [engine, channelId]) ?? EMPTY_FOLD;
  return {
    fold,
    roster: fold.present.map((p) => ({ identity: p.identity, author: verifiedAuthorOf(fold, p.identity) })),
  };
}

/**
 * A voice channel in the sidebar (CORD-07): selecting it opens the channel like
 * any other (chat + the call panel render in the main view); it is NOT a join.
 * A live-count badge and the roster of present members show at a glance who's
 * in the call.
 */
function VoiceChannelRow({
  cid,
  channelId,
  name,
  selected,
  onSelect,
}: {
  cid: string;
  channelId: string;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const call = useCall();
  const { fold, roster } = useRoster(cid, channelId);
  const inThisCall = call.active?.channelId === channelId && call.active?.cid === cid;

  return (
    <div className="mb-px">
      <button
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded w-full text-left font-medium ${
          selected ? "bg-base-300 text-base-content" : "text-base-content/60 hover:bg-base-300 hover:text-base-content"
        }`}
        onClick={onSelect}
      >
        <span className="inline-flex items-center text-base-content/60"><Volume2 size={16} /></span>
        <span>{name}</span>
        {inThisCall && <span className="w-2 h-2 rounded-full bg-success ml-auto" title="You're in this call" />}
        {fold.present.length > 0 && (
          <span className={`text-[11px] font-semibold text-base-content/60 bg-base-300 rounded-lg px-1.5 py-px ${inThisCall ? "ml-1.5" : "ml-auto"}`}>
            {fold.present.length}
          </span>
        )}
      </button>
      {roster.length > 0 && (
        <div className="flex flex-col gap-0.5 pt-0.5 pb-1 pl-[26px]">
          {roster.map((r) => (
            <div key={r.identity} className="flex items-center gap-1.5 text-[13px] text-base-content/60">
              {r.author ? (
                <>
                  <UserAvatar pubkey={r.author} className="w-5 h-5" />
                  <span className="truncate"><UserName pubkey={r.author} /></span>
                </>
              ) : (
                <span className="italic opacity-70">Unverified</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The call surface at the top of a voice channel's view. When you're in this
 * channel's call, it hosts the live stage (the persistent VoiceRoom portals into
 * the slot). Otherwise it's a pre-join toolbar: who's in the call + a Join
 * button. Chat renders below it either way.
 */
function VoiceCallPanel({ cid, channelId, name }: { cid: string; channelId: string; name: string }) {
  const { active, pending, error, join, setStageEl } = useCall();
  const { roster } = useRoster(cid, channelId);
  const isActiveHere = active?.cid === cid && active?.channelId === channelId;
  const isPendingHere = pending?.cid === cid && pending?.channelId === channelId;

  // Host the persistent call surface here. `setStageEl` is the stable state
  // setter, so it's safe as a ref callback (node on mount, null on unmount).
  if (isActiveHere) return <div ref={setStageEl} />;

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

type ReplyTarget = { id: string; author: string };

/** Render a quick-reaction label: a unicode char, or a custom emoji image. */
function reactionLabel(r: string | Emoji) {
  return typeof r === "string" ? (
    r
  ) : (
    <img className="h-[1.35em] w-auto align-middle object-contain" src={r.url} alt={`:${r.shortcode}:`} loading="lazy" />
  );
}

function MentionsView({
  cid,
  state,
  mobileNav,
  onOpenChannel,
}: {
  cid: string;
  state: CommunityState;
  mobileNav: React.ReactNode;
  onOpenChannel: (channelId: string, msgId?: string) => void;
}) {
  const community = useCommunity(cid);
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const readState = useReadState(pubkey);

  // Only scan text channels the user can read (public + held private channels).
  const readableChannelIds = useMemo(
    () =>
      state.channels
        .filter((c) => !c.voice && (!c.private || community?.material.channels.some((mc) => mc.id === c.channel_id)))
        .map((c) => c.channel_id),
    [state.channels, community],
  );
  const mentions = useMentions(community, cid, readableChannelIds, pubkey);

  // Freeze the cursor at entry so the "New" divider stays put while reading,
  // then advance it to the newest mention once the view is mounted + focused.
  const [frozenCursor, setFrozenCursor] = useState(() => getMentionsLastRead(readState, cid));
  const [frozenKey, setFrozenKey] = useState(cid);
  if (frozenKey !== cid) {
    setFrozenKey(cid);
    setFrozenCursor(getMentionsLastRead(readState, cid));
  }

  const newestMs = mentions.length ? mentions[0].ms : 0;
  useEffect(() => {
    if (!pubkey || !cid || !newestMs) return;
    markMentionsRead(pubkey, cid, newestMs);
  }, [pubkey, cid, newestMs]);

  const channelName = useCallback(
    (channelId: string) => state.channels.find((c) => c.channel_id === channelId)?.name ?? "unknown",
    [state.channels],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
      <div className="h-12 flex items-center px-4 gap-2 border-b border-base-300 shadow-sm shrink-0">
        {mobileNav}
        <span className="inline-flex items-center text-base-content/60"><AtSign size={20} /></span>
        <span className="font-semibold text-base-content">Mentions</span>
        <span className="text-base-content/60 text-[13px] border-l border-base-300 pl-2 ml-1 max-md:hidden">
          {state.metadata?.name ?? state.material.name}
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {mentions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-base-content/60 gap-2 text-center p-10">
            <div className="flex items-center justify-center"><AtSign size={48} /></div>
            <div>No mentions yet. When someone mentions you in a channel, it will show up here.</div>
          </div>
        ) : (
          <div className="max-w-[min(860px,calc(100%-24px))] mx-auto py-4">
            {mentions.map((m) => {
              const isNew = m.ms > frozenCursor;
              return (
                <Fragment key={m.id}>
                  {isNew && (
                    <div className="flex items-center gap-2 px-4 py-1 select-none" data-new-divider>
                      <div className="flex-1 h-px bg-error" />
                      <span className="text-error text-[10px] font-bold uppercase tracking-wide">New</span>
                    </div>
                  )}
                  <button
                    className="group flex gap-3.5 px-4 py-2 w-full text-left hover:bg-base-200 rounded-lg max-sm:gap-2.5 max-sm:px-2"
                    onClick={() => onOpenChannel(m.channelId, m.id)}
                  >
                    <UserAvatar pubkey={m.author} className="w-10 h-10 mt-0.5 shrink-0 max-sm:w-8 max-sm:h-8" />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className="font-semibold shrink-0" style={{ color: colorFor(m.author) }}>
                          <UserName pubkey={m.author} />
                        </span>
                        <span className="text-[11px] text-base-content/60 shrink-0">{formatTime(m.ms)}</span>
                        <span className="inline-flex items-center gap-1 text-[11px] text-base-content/60 shrink-0">
                          <Hash size={11} />{channelName(m.channelId)}
                        </span>
                      </div>
                      <div className="text-base-content/90 break-words">
                        <MessageContent text={m.content} attachments={m.attachments} emojiTags={m.emojiTags} />
                      </div>
                    </div>
                  </button>
                </Fragment>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// The chat view is split into three independently-rendering pieces so a keystroke
// in the composer never re-renders the (potentially long) message list:
//   • ChatView    — owns the message stream, scroll, and shared reply target.
//   • MessageList — memoized; re-renders only when the messages/groups change.
//   • Composer    — owns the draft text/files/sending/picker state locally.
function ChatView({
  cid,
  channelId,
  state,
  mobileNav,
  threadsOpen,
  membersOpen,
  onToggleThreads,
  onToggleMembers,
  onOpenThread,
}: {
  cid: string;
  channelId: string;
  state: CommunityState;
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
  const messages = useMessages(community, channelId);
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const [searchParams] = useSearchParams();
  const jumpTargetId = searchParams.get("msg");
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
  useMarkRead(pubkey, cid, channelId, newestMs, atBottom);

  const hasChannelKey = !channel?.private || (community?.material.channels.some((c) => c.id === channelId) ?? false);
  const canDirectInvite = Boolean(community && hasChannelKey && (channel?.private ? canManageChannels : canCreateInvite));

  // The user's NIP-30 favorite custom emojis (kind 10030 + referenced packs).
  const favorites = useFavoriteEmojis(pubkey, account?.signer);
  // Quick-react buttons: lead with the user's favorites, backfill with defaults.
  // Memoized so the reference stays stable and doesn't defeat MessageList's memo.
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
  }, []);

  // The list is column-reverse, so entering a channel already lands on the
  // newest message and stays there as messages arrive — no effect needed. Only
  // the unread divider (or a deep-linked `?msg=` target) has to be scrolled to.
  const positionedFor = useRef("");
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || positionedFor.current === channelId) return;
    // Wait for history: a channel's rumors hydrate from IndexedDB and stream
    // in from relays, so the first render is routinely empty.
    if (messages.length === 0) return;
    positionedFor.current = channelId;
    // A deep-linked message (from the Mentions view) takes priority over the
    // unread divider: scroll it into view, centered.
    if (jumpTargetId) {
      const target = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(jumpTargetId)}"]`);
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.focus({ preventScroll: true });
        return;
      }
    }
    if (!dividerId) return;
    const target = el.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(dividerId)}"]`);
    // Land on the divider with a little history above it for context, rather
    // than flush against the top edge.
    if (target) el.scrollTop += target.getBoundingClientRect().top - el.getBoundingClientRect().top - 64;
  }, [channelId, messages, dividerId, jumpTargetId]);

  // Switching channels clears the shared reply target (the composer resets its
  // own draft via its `key`). Done during render — the documented alternative to
  // a setState-in-effect — so it applies before the children paint.
  const [prevChannel, setPrevChannel] = useState(channelId);
  if (channelId !== prevChannel) {
    setPrevChannel(channelId);
    setReplyTo(null);
  }

  const canWrite = !state.dissolved;

  // Roster of pubkeys the composer's @-mention menu searches. Memoized on the
  // Set reference so the composer's memo isn't defeated by unrelated re-renders.
  const members = useMemo(() => [...state.members], [state.members]);

  const handleSend = useCallback(
    async (
      value: string,
      files: File[],
      reply: ReplyTarget | null,
      onUploadProgress: (progress: Storage.ConcordUploadProgress) => void,
    ) => {
      setReplyTo(null);
      await community?.sendMessage(channelId, value, reply ?? undefined, files.length ? files : undefined, favorites, {
        onUploadProgress,
      });
    },
    [community, channelId, favorites],
  );

  const jumpToMessage = useCallback((id: string) => {
    const scrollEl = scrollRef.current;
    const target = scrollEl?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`);
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
    target?.focus({ preventScroll: true });
  }, []);

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
      <div className="h-12 flex items-center px-4 gap-2 border-b border-base-300 shadow-sm shrink-0">
        {mobileNav}
        <span className="inline-flex items-center text-base-content/60">
          {channel?.voice ? <Volume2 size={20} /> : channel?.private ? <Lock size={20} /> : <Hash size={20} />}
        </span>
        <span className="font-semibold text-base-content">{channel?.name}</span>
        <span className="text-base-content/60 text-[13px] border-l border-base-300 pl-2 ml-1 max-md:hidden">{state.metadata?.description}</span>
        <div className="flex-1" />
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
        <button className={`btn btn-ghost btn-sm btn-circle ${threadsOpen ? "btn-active" : ""}`} title="Threads" onClick={onToggleThreads}>
          <MessageSquare size={18} />
        </button>
        <button className={`btn btn-ghost btn-sm btn-circle ${membersOpen ? "btn-active" : ""}`} title="Members" onClick={onToggleMembers}>
          <Users size={18} />
        </button>
      </div>
      {directInviteOpen && community && (
        <DirectInviteModal community={community} state={state} channel={channel} onClose={() => setDirectInviteOpen(false)} />
      )}
      {privateDebugOpen && community && channel?.private && (
        <PrivateChannelDebugModal
          community={community}
          state={state}
          channel={channel}
          channelId={channelId}
          myPubkey={pubkey}
          canCreateInvite={canCreateInvite}
          canManageChannels={canManageChannels}
          hasChannelKey={hasChannelKey}
          canDirectInvite={canDirectInvite}
          canWrite={canWrite}
          onClose={() => setPrivateDebugOpen(false)}
        />
      )}
      {channel?.voice && <VoiceCallPanel cid={cid} channelId={channelId} name={channel.name} />}
      <MessageList
        ref={scrollRef}
        messages={messages}
        channelName={channel?.name}
        ownerPubkey={state.material.owner}
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
      {canWrite && (
        <Composer
          key={channelId}
          channelName={channel?.name}
          channelPrivate={Boolean(channel?.private)}
          favorites={favorites}
          members={members}
          replyTo={replyTo}
          onClearReply={() => setReplyTo(null)}
          onSend={handleSend}
        />
      )}
    </div>
  );
}

function PrivateChannelDebugModal({
  community,
  state,
  channel,
  channelId,
  myPubkey,
  canCreateInvite,
  canManageChannels,
  hasChannelKey,
  canDirectInvite,
  canWrite,
  onClose,
}: {
  community: ConcordCommunity;
  state: CommunityState;
  channel: ChannelMetadata;
  channelId: string;
  myPubkey: string;
  canCreateInvite: boolean;
  canManageChannels: boolean;
  hasChannelKey: boolean;
  canDirectInvite: boolean;
  canWrite: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const materialChannel = community.material.channels.find((c) => c.id === channelId);
  const isOwner = myPubkey === state.material.owner;
  const foldedHasKey = Boolean(channel.key);
  const materialHasKey = Boolean(materialChannel?.key);
  const foldedMatchesMaterial = Boolean(channel.key && materialChannel?.key && channel.key === materialChannel.key);
  const suspectedFallbackRisk = channel.private && !foldedHasKey;
  const snapshot = {
    communityId: state.material.community_id,
    channelId,
    channelName: channel.name,
    channelPrivate: channel.private,
    channelDeleted: Boolean(channel.deleted),
    viewer: myPubkey,
    owner: state.material.owner,
    isOwner,
    permissions: {
      canCreateInvite,
      canManageChannels,
      appHasChannelKey: hasChannelKey,
      canDirectInvite,
      canWrite,
    },
    foldedChannel: {
      hasKey: foldedHasKey,
      epoch: channel.epoch,
      keyPrefix: channel.key ? `${channel.key.slice(0, 8)}…` : null,
    },
    materialChannel: materialChannel
      ? {
          id: materialChannel.id,
          name: materialChannel.name,
          hasKey: materialHasKey,
          epoch: materialChannel.epoch,
          heldEpochs: materialChannel.held?.map((h) => h.epoch) ?? [],
          keyPrefix: materialChannel.key ? `${materialChannel.key.slice(0, 8)}…` : null,
        }
      : null,
    foldedMatchesMaterial,
    suspectedFallbackRisk,
  };
  const json = JSON.stringify(snapshot, null, 2);

  async function copy() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-xl font-bold mb-1">Private channel debug</h2>
      <p className="text-sm opacity-70 mb-4">
        Dev-only state for checking whether private channel metadata and held key material agree.
      </p>

      {suspectedFallbackRisk && (
        <div className="alert alert-warning text-sm mb-4 items-start">
          <ShieldQuestion size={18} className="mt-0.5" />
          <span>
            This private channel is folded without local key material. If sending still works, the upstream package may be
            deriving a fallback community-root channel key for a private channel.
          </span>
        </div>
      )}

      <div className="rounded-box border border-base-300 overflow-hidden mb-4">
        <DebugRow label="Viewer is owner" value={isOwner ? "yes" : "no"} good={isOwner} />
        <DebugRow label="Can manage channels" value={canManageChannels ? "yes" : "no"} good={canManageChannels} />
        <DebugRow label="Can create invites" value={canCreateInvite ? "yes" : "no"} good={canCreateInvite} />
        <DebugRow label="Material has channel key" value={materialHasKey ? "yes" : "no"} good={materialHasKey} />
        <DebugRow label="App hasChannelKey gate" value={hasChannelKey ? "yes" : "no"} good={hasChannelKey} />
        <DebugRow label="Folded channel has key" value={foldedHasKey ? "yes" : "no"} good={foldedHasKey} />
        <DebugRow label="Folded key matches material" value={foldedMatchesMaterial ? "yes" : "no"} good={foldedMatchesMaterial} />
        <DebugRow label="App composer can write" value={canWrite ? "yes" : "no"} good={!suspectedFallbackRisk || !canWrite} />
        <DebugRow label="Direct invite enabled" value={canDirectInvite ? "yes" : "no"} good={!suspectedFallbackRisk || !canDirectInvite} />
      </div>

      <div className="flex items-center gap-2 mb-2">
        <h3 className="font-semibold">Snapshot</h3>
        <button className="btn btn-xs ml-auto" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
      <pre className="text-xs bg-base-200 border border-base-300 rounded-box p-3 overflow-auto max-h-72">{json}</pre>

      <div className="modal-action">
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

function DebugRow({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3 py-2 border-b border-base-300 last:border-b-0 text-sm">
      <span className="flex-1 opacity-70">{label}</span>
      <span className={`badge ${good ? "badge-success" : "badge-warning"}`}>{value}</span>
    </div>
  );
}

// The "new messages" line: where you stopped reading last visit. Frozen for the
// duration of the visit by useNewMessagesDivider, so it stays put while you read.
function NewMessagesDivider() {
  return (
    <div className="flex items-center gap-2 px-4 py-1 select-none" data-new-divider>
      <div className="flex-1 h-px bg-error" />
      <span className="text-error text-[10px] font-bold uppercase tracking-wide">New</span>
    </div>
  );
}

const MessageList = memo(function MessageList({
  ref,
  messages,
  channelName,
  ownerPubkey,
  myPubkey,
  canWrite,
  community,
  channelId,
  dividerId,
  favorites,
  quickReactions,
  onReply,
  onJumpToMessage,
  onThread,
}: {
  ref: React.Ref<HTMLDivElement>;
  messages: ChatMessage[];
  channelName: string | undefined;
  ownerPubkey: string;
  myPubkey: string;
  canWrite: boolean;
  community: ConcordCommunity | undefined;
  channelId: string;
  dividerId: string | undefined;
  favorites: Emoji[];
  quickReactions: (string | Emoji)[];
  onReply: (r: ReplyTarget) => void;
  onJumpToMessage: (id: string) => void;
  onThread: (m: ChatMessage) => void;
}) {
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // Collapse consecutive messages from the same author (within 2 min) into one
  // avatar group — Discord/Slack style. Replies always start a fresh header.
  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className="flex-1 flex min-h-0">
      {/* col-reverse puts the scroll origin at the newest message: the view starts
        * pinned to the bottom and stays there as messages arrive, with no scroll
        * effect and no jump. Short history packs against the bottom on its own, so
        * no spacer either. The inner wrapper is one flex item, so groups still read
        * oldest-to-newest inside it. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-4 flex flex-col-reverse" ref={ref}>
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-base-content/60 gap-2 text-center p-10">
            <div className="flex items-center justify-center"><Hand size={48} /></div>
            <div>This is the beginning of #{channelName}. Say hello!</div>
          </div>
        ) : (
          <div>
            {groups.map((group) => (
              <div className="mt-3.5 first-of-type:mt-0" key={group[0].id}>
                {group.map((m, i) => (
                  <Fragment key={m.id}>
                    {m.id === dividerId && <NewMessagesDivider />}
                    <Message
                      m={m}
                      showHeader={i === 0 || Boolean(m.replyTo)}
                      replyPreview={m.replyTo ? byId.get(m.replyTo.id)?.content ?? "message" : undefined}
                      ownerPubkey={ownerPubkey}
                      myPubkey={myPubkey}
                      canWrite={canWrite}
                      community={community}
                      channelId={channelId}
                      favorites={favorites}
                      quickReactions={quickReactions}
                      onReply={onReply}
                      onJumpToMessage={onJumpToMessage}
                      onThread={onThread}
                    />
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// One message row. Memoized and holding its own edit / reaction-picker state, so
// editing or opening a picker on one message never re-renders its siblings.
// (The client rebuilds ChatMessage objects on every stream update, so memo can't
// yet skip rows on genuine data changes — but it does isolate them from parent
// re-renders driven by the reply bar or another row's picker.)
const Message = memo(function Message({
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
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const react = (reaction: string | Emoji) => community?.react(channelId, { id: m.id, author: m.author }, reaction);

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
                <button className="btn btn-ghost btn-sm btn-circle" title="Delete" onClick={() => community?.deleteMessage(channelId, m.id)}>
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </>
        )}
        <span className="relative inline-flex">
          <button className="btn btn-ghost btn-sm btn-circle" title="More" onClick={() => setMenuOpen((v) => !v)}>
            <MoreVertical size={16} />
          </button>
          {menuOpen && (
            <MessageMenu
              onClose={() => setMenuOpen(false)}
              onViewRaw={() => {
                setMenuOpen(false);
                setRawOpen(true);
              }}
            />
          )}
        </span>
      </div>
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex items-end bg-black/45" onClick={() => setDrawerOpen(false)}>
          <div className="w-full rounded-t-2xl bg-base-100 border-t border-base-300 p-4 shadow-2xl" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
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
                      <button className="btn btn-ghost justify-start text-error" onClick={() => actionAndClose(() => community?.deleteMessage(channelId, m.id))}>
                        <Trash2 size={18} /> Delete
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
            <div className="mt-1 flex flex-col gap-1">
              <button className="btn btn-ghost justify-start" onClick={() => actionAndClose(() => setRawOpen(true))}>
                <MoreVertical size={18} /> View raw
              </button>
            </div>
          </div>
        </div>
      )}
      {rawOpen && <RawEventModal message={m} onClose={() => setRawOpen(false)} />}
    </div>
  );
});

// The per-message "more options" dropdown. Closes on outside-click or Escape.
function MessageMenu({ onClose, onViewRaw }: { onClose: () => void; onViewRaw: () => void }) {
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
      <button className="w-full text-left px-2.5 py-1.5 rounded text-sm hover:bg-base-300" onClick={onViewRaw}>
        View raw
      </button>
    </div>
  );
}

/**
 * The right-hand side panel: hosts either the member roster or the channel's
 * threads/thread view. Opened from the sidebar (members) or the chat header
 * (threads); closed via its own close button. Replaces the old always-on
 * member list and the floating thread overlay.
 *
 * The panel separates from the chat by surface colour (base-200 against the
 * chat's base-100) rather than a rule, and its contents avoid card chrome — the
 * whole right side reads as one flat surface.
 */
function SidePanel({
  mode,
  state,
  cid,
  channelId,
  threadRootId,
  favorites,
  canWrite,
  onOpenThread,
  onCloseThread,
  onClose,
}: {
  mode: "members" | "threads";
  state: CommunityState;
  cid: string;
  channelId: string | null;
  threadRootId: string | null;
  favorites: Emoji[];
  canWrite: boolean;
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
  onClose: () => void;
}) {
  const title = mode === "members" ? "Members" : threadRootId ? "Thread" : "Threads";
  return (
    <aside className="w-88 shrink-0 flex flex-col bg-base-200 min-h-0 max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-[min(400px,92vw)] max-md:shadow-2xl">
      <div className="h-12 shrink-0 flex items-center justify-between gap-3 px-4">
        <span className="font-bold text-base-content">{title}</span>
        <button className="btn btn-ghost btn-sm btn-circle" title="Close panel" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {mode === "members" ? (
          <MemberList state={state} />
        ) : channelId ? (
          <ThreadsPanel
            cid={cid}
            channelId={channelId}
            threadRootId={threadRootId}
            canWrite={canWrite}
            favorites={favorites}
            onOpenThread={onOpenThread}
            onCloseThread={onCloseThread}
          />
        ) : (
          <div className="h-full min-h-[260px] flex flex-col items-center justify-center gap-2 text-center text-base-content/60">
            <MessageSquare size={36} />
            <div className="text-base-content font-bold">Select a channel to see its threads.</div>
          </div>
        )}
      </div>
    </aside>
  );
}

function ThreadsPanel({
  cid,
  channelId,
  threadRootId,
  canWrite,
  favorites,
  onOpenThread,
  onCloseThread,
}: {
  cid: string;
  channelId: string;
  threadRootId: string | null;
  canWrite: boolean;
  favorites: Emoji[];
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
}) {
  const community = useCommunity(cid);
  const messages = useMessages(community, channelId);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const roots = useMemo(() => messages.filter((m) => m.threadReplyCount > 0), [messages]);
  const root = threadRootId ? byId.get(threadRootId) ?? null : null;

  if (root) {
    return (
      <ThreadView
        cid={cid}
        channelId={channelId}
        root={root}
        canWrite={canWrite}
        favorites={favorites}
        onBack={onCloseThread}
      />
    );
  }
  return <ThreadIndex roots={roots} onOpen={(m) => onOpenThread(m.id)} />;
}

function ThreadIndex({ roots, onOpen }: { roots: ChatMessage[]; onOpen: (m: ChatMessage) => void }) {
  if (roots.length === 0)
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center text-base-content/60 p-4">
        <MessageSquare size={36} />
        <div className="text-base-content font-bold">No threads yet.</div>
        <p className="m-0 max-w-[220px] text-[13px]">Use “Reply in thread” on a message to start one.</p>
      </div>
    );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-4">
      {roots.map((root) => (
        <button
          className="w-full flex gap-3 rounded-lg p-2 text-left hover:bg-base-300/60"
          key={root.id}
          onClick={() => onOpen(root)}
        >
          <UserAvatar pubkey={root.author} className="w-9 h-9 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-semibold truncate" style={{ color: colorFor(root.author) }}>
                <UserName pubkey={root.author} />
              </span>
              <span className="text-[11px] text-base-content/60 shrink-0 ml-auto">{clockTime(root.ms)}</span>
            </div>
            <div className="mt-0.5 text-sm leading-snug text-base-content/80 line-clamp-2 break-words">
              {root.deleted ? "(message deleted)" : (root.edited ?? root.content) || "message"}
            </div>
            <div className="mt-1 text-primary text-[13px] font-semibold">
              {root.threadReplyCount} {root.threadReplyCount === 1 ? "reply" : "replies"}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

function ThreadView({
  cid,
  channelId,
  root,
  canWrite,
  favorites,
  onBack,
}: {
  cid: string;
  channelId: string;
  root: ChatMessage;
  canWrite: boolean;
  favorites: Emoji[];
  onBack: () => void;
}) {
  const community = useCommunity(cid);
  const comments = useThread(community, channelId, root.id);
  const [replyParent, setReplyParent] = useState<{ id: string; author: string; kind: number } | null>(null);
  const byId = useMemo(() => new Map(comments.map((c) => [c.id, c])), [comments]);
  // No explicit target means replying to the thread root itself.
  const parent = replyParent ?? { id: root.id, author: root.author, kind: kinds.ChatMessage };

  async function sendThreadReply(text: string) {
    if (!community) return;
    await sendThreadReplyAction(community, channelId, parent, text, favorites);
    setReplyParent(null);
  }

  return (
    <>
      <button
        className="shrink-0 flex items-center gap-1.5 px-4 py-2 text-base-content/60 text-[13px] hover:text-base-content"
        onClick={onBack}
      >
        <ArrowLeft size={14} /> All threads
      </button>
      {/* col-reverse keeps the scroll anchored to the newest comment: the browser
       * pins scrollTop to the reversed start, so new replies don't push the view.
       * The inner wrapper is one flex item, so its content still reads top-down. */}
      <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4 flex flex-col-reverse">
        <div>
          <div className="flex gap-3 pb-3">
            <UserAvatar pubkey={root.author} className="w-10 h-10 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-semibold" style={{ color: colorFor(root.author) }}>
                  <UserName pubkey={root.author} />
                </span>
                <span className="text-[11px] text-base-content/60">{formatTime(root.ms)}</span>
              </div>
              {root.deleted ? (
                <div className="text-base-content/60 italic">(message deleted)</div>
              ) : (
                <MessageContent text={root.edited ?? root.content} attachments={root.attachments} emojiTags={root.emojiTags} />
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-base-content/50">
            <span className="shrink-0">
              {comments.length === 0 ? "No replies yet" : `${comments.length} ${comments.length === 1 ? "reply" : "replies"}`}
            </span>
            <span className="h-px flex-1 bg-base-300" />
          </div>

          {comments.map((comment) => {
            // Nested replies stay in one flat list; the chip names the parent so the
            // shape of the conversation survives without indentation.
            const parentComment = comment.parent.kind === COMMENT_KIND ? byId.get(comment.parent.id) : undefined;
            const replying = replyParent?.id === comment.id;
            return (
              <div
                className={`group flex gap-3 -mx-2 px-2 py-1.5 rounded-lg ${replying ? "bg-primary/10" : "hover:bg-base-300/50"}`}
                key={comment.id}
              >
                <UserAvatar pubkey={comment.author} className="w-8 h-8 mt-0.5" />
                <div className="min-w-0 flex-1">
                  {parentComment && (
                    <div className="flex items-center gap-1 mb-0.5 text-[11px] text-base-content/50 min-w-0">
                      <CornerDownRight size={11} className="shrink-0" />
                      <span className="shrink-0">replying to</span>
                      <span className="font-medium truncate" style={{ color: colorFor(parentComment.author) }}>
                        <UserName pubkey={parentComment.author} />
                      </span>
                    </div>
                  )}
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="font-semibold text-sm" style={{ color: colorFor(comment.author) }}>
                      <UserName pubkey={comment.author} />
                    </span>
                    <span className="text-[11px] text-base-content/60">{clockTime(comment.ms)}</span>
                  </div>
                  {comment.deleted ? (
                    <div className="text-base-content/60 italic">(message deleted)</div>
                  ) : (
                    <MessageContent text={comment.content} attachments={[]} emojiTags={comment.emojiTags} />
                  )}
                </div>
                {canWrite && (
                  <button
                    className="btn btn-ghost btn-xs btn-circle self-start shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100"
                    title="Reply to this comment"
                    onClick={() => setReplyParent({ id: comment.id, author: comment.author, kind: COMMENT_KIND })}
                  >
                    <Reply size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {canWrite && (
        <ThreadComposer
          replyingTo={replyParent?.author ?? null}
          favorites={favorites}
          onClear={() => setReplyParent(null)}
          onSend={sendThreadReply}
        />
      )}
    </>
  );
}

/** `replyingTo` is null when the reply targets the thread root — the common case,
 * where the placeholder alone is enough and the reply bar would just be noise. */
function ThreadComposer({
  replyingTo,
  favorites,
  onClear,
  onSend,
}: {
  replyingTo: string | null;
  favorites: Emoji[];
  onClear: () => void;
  onSend: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  async function send() {
    const value = text.trim();
    if (!value || sending) return;
    setText("");
    setSending(true);
    try {
      await onSend(value);
    } catch (err) {
      console.error("thread reply failed", err);
      setText(value);
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
    <div className="shrink-0 px-4 pb-4 max-sm:px-2">
      {replyingTo && (
        <div className="flex items-center justify-between gap-2 px-1 pb-1 text-[12px] text-base-content/60">
          <span className="flex items-center gap-1 min-w-0">
            <CornerDownRight size={12} className="shrink-0" />
            <span className="truncate">
              Replying to <UserName pubkey={replyingTo} />
            </span>
          </span>
          <button className="btn btn-ghost btn-xs btn-circle shrink-0" title="Reply to the thread instead" onClick={onClear}>
            <X size={14} />
          </button>
        </div>
      )}
      <div className="flex items-end gap-2 bg-base-100 rounded-xl p-2">
        <span className="relative inline-flex shrink-0">
          <button className="btn btn-ghost btn-sm btn-circle" title="Emoji" onClick={() => setPickerOpen((v) => !v)}>
            <SmilePlus size={18} />
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
          className="flex-1 min-w-0 min-h-9 max-h-35 resize-y bg-transparent outline-none border-0 leading-snug text-base-content"
          rows={1}
          placeholder={replyingTo ? "Write a reply…" : "Reply in thread"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn btn-primary btn-sm btn-circle shrink-0"
          title="Send"
          onClick={send}
          disabled={sending || !text.trim()}
        >
          {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
        </button>
      </div>
    </div>
  );
}

// The message composer. Owns its draft state locally so keystrokes re-render only
// this component, not the message list above it.
const Composer = memo(function Composer({
  channelName,
  channelPrivate,
  favorites,
  members,
  replyTo,
  onClearReply,
  onSend,
}: {
  channelName: string | undefined;
  channelPrivate: boolean;
  favorites: Emoji[];
  members: string[];
  replyTo: ReplyTarget | null;
  onClearReply: () => void;
  onSend: (
    text: string,
    files: File[],
    reply: ReplyTarget | null,
    onUploadProgress: (progress: Storage.ConcordUploadProgress) => void,
  ) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [upload, setUpload] = useState<Storage.ConcordUploadProgress | null>(null);
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
  const candidates = useMentionCandidates(members);
  const searchMentions = useMentionSearch(candidates);
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
    if (sending) return;
    if (!value && files.length === 0) return;
    const attach = files;
    const reply = replyTo;
    setText("");
    setMention(null);
    setFiles([]);
    setSending(true);
    setUpload(null);
    try {
      await onSend(value, attach, reply, setUpload);
    } catch (err) {
      console.error("send failed", err);
      // Restore the draft so the user doesn't lose their message/attachments.
      setText(value);
      setFiles(attach);
    } finally {
      setUpload(null);
      setSending(false);
    }
  }

  return (
    <div className="px-4 pb-5 shrink-0 max-sm:px-2">
      {replyTo && (
        <div className="flex justify-between bg-base-200 rounded-t-lg px-4 py-1.5 text-[13px] text-base-content/60 -mb-1 max-sm:px-2">
          <span>
            Replying to <UserName pubkey={replyTo.author} />
          </span>
          <button className="btn btn-ghost btn-sm btn-circle" onClick={onClearReply}>
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
              <button className="text-base-content/60 hover:text-error inline-flex" onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
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
      <div className="relative flex items-center gap-1 bg-base-200 rounded-lg px-4 max-sm:px-2">
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
        <button className="btn btn-ghost btn-sm btn-circle" title="Attach files" onClick={() => fileInputRef.current?.click()}>
          <Paperclip size={20} />
        </button>
        <span className="relative inline-flex">
          <button className="btn btn-ghost btn-sm btn-circle" title="Emoji" onClick={() => setPickerOpen((v) => !v)}>
            <SmilePlus size={20} />
          </button>
          {pickerOpen && (
            <EmojiPicker
              favorites={favorites}
              align="right"
              direction="up"
              onPick={(e) => insertEmoji(e)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </span>
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
          rows={1}
          className="composer-textarea flex-1 min-w-0 bg-transparent border-0 outline-none resize-none py-3 max-h-50 leading-snug text-base-content"
          placeholder={`Message ${channelPrivate ? "🔒" : "#"}${channelName ?? ""}`}
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
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button
          className="btn btn-primary btn-sm max-[380px]:btn-square"
          onClick={send}
          disabled={sending || (!text.trim() && files.length === 0)}
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
        </button>
      </div>
    </div>
  );
});

/** A u32 role colour as a CSS hex string, or undefined for the theme default. */
function roleColor(color: number): string | undefined {
  return color ? `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}` : undefined;
}

function MemberList({ state }: { state: CommunityState }) {
  const owner = state.material.owner;
  const rolesById = useMemo(() => new Map(state.roles.map((r) => [r.role_id, r])), [state.roles]);

  // Each member's highest-authority Role (lowest `position`), Discord-style: a
  // member is hoisted under one role only. The owner is special-cased above.
  const primaryRole = useCallback(
    (m: string): Role | undefined => {
      let best: Role | undefined;
      for (const id of state.grants.get(m) ?? []) {
        const r = rolesById.get(id);
        if (r && (!best || r.position < best.position)) best = r;
      }
      return best;
    },
    [state.grants, rolesById],
  );

  const row = (m: string, role?: Role) => (
    <div className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-base-300" key={m} title={m}>
      <UserAvatar pubkey={m} />
      <span className="font-medium truncate" style={role ? { color: roleColor(role.color) } : undefined}>
        <UserName pubkey={m} />
      </span>
      {m === owner ? (
        <span className="badge badge-warning badge-sm ml-auto">Owner</span>
      ) : (
        role && (
          <span className="badge badge-sm ml-auto text-white" style={{ background: roleColor(role.color) }}>
            {role.name}
          </span>
        )
      )}
    </div>
  );

  const members = [...state.members];
  const ownerMembers = members.filter((m) => m === owner);
  // Group the rest under their highest role, in authority order (lowest
  // `position` first), then a trailing roleless "Members" section.
  const nonOwner = members.filter((m) => m !== owner);
  const roleless = nonOwner.filter((m) => !primaryRole(m)).sort();
  const sections = [...state.roles]
    .sort((a, b) => a.position - b.position || (a.role_id < b.role_id ? -1 : 1))
    .map((r) => ({ role: r, members: nonOwner.filter((m) => primaryRole(m)?.role_id === r.role_id).sort() }))
    .filter((s) => s.members.length > 0);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-4 px-2">
      {ownerMembers.length > 0 && (
        <>
          <h4 className="text-[11px] uppercase text-base-content/60 px-2 pb-1.5 mt-2 mb-1">Owner</h4>
          {ownerMembers.map((m) => row(m))}
        </>
      )}
      {sections.map((s) => (
        <div key={s.role.role_id}>
          <h4 className="text-[11px] uppercase px-2 pb-1.5 mt-2 mb-1" style={{ color: roleColor(s.role.color) }}>
            {s.role.name} — {s.members.length}
          </h4>
          {s.members.map((m) => row(m, s.role))}
        </div>
      ))}
      {roleless.length > 0 && (
        <>
          <h4 className="text-[11px] uppercase text-base-content/60 px-2 pb-1.5 mt-2 mb-1">Members — {roleless.length}</h4>
          {roleless.map((m) => row(m))}
        </>
      )}
      {members.length === 0 && <p className="text-base-content/60 p-2">No members yet.</p>}
      {state.banlist.size > 0 && (
        <>
          <h4 className="text-[11px] uppercase text-error px-2 pb-1.5 mt-3 mb-1">Banned — {state.banlist.size}</h4>
          {[...state.banlist].sort().map((m) => (
            <div className="flex items-center gap-2.5 px-2 py-1.5 rounded opacity-60" key={m} title={m}>
              <UserAvatar pubkey={m} />
              <span className="font-medium truncate">
                <UserName pubkey={m} />
              </span>
              <span className="badge badge-sm ml-auto border-0 bg-error/15 text-error">Banned</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
