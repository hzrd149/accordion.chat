import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useMatch, useNavigate, useParams, useSearchParams } from "react-router";
import { AtSign, Hash, Inbox, Lock, LogOut, Menu, MessageSquare, Plus, Settings, UserPlus, Volume2, Wrench, X } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { accounts } from "../nostr";
import { ConcordProvider } from "../components/ConcordProvider";
import { CallProvider } from "../components/voice/CallProvider";
import { useCall } from "../components/voice/call-context";
import { useConcord } from "../hooks/use-concord";
import { useCommunity } from "../hooks/use-community";
import { useInvites } from "../hooks/use-invites";
import { useUnreadCounts, type ChannelUnread } from "../chat/useUnread";
import { useMentions } from "../chat/useMentions";
import { Login } from "./Login";
import { CreateChannelModal, CreateCommunityModal, InviteModal, JoinModal, Modal } from "../components/modals";
import { colorFor, formatTime } from "../helpers/util";
import { defaultRoute } from "../helpers/route-defaults";
import { UserAvatar, UserName } from "../components/User";
import { SettingsView } from "./settings";
import { DevView } from "./dev";
import { useDevMode } from "../hooks/use-dev-mode";
import { messagesEnabled$ } from "../services/messages";
import { InvitesView } from "./invites";
import { DmView } from "./dm";
import { ThemeToggle } from "../components/ThemeToggle";
import { ClientStatusRailIndicator, CommunityStatusDot } from "../components/ClientStatus";
import { CommunitySettingsView } from "./community-settings";
import { useDecryptedImage } from "../hooks/useDecryptedImage";
import { MessageContent } from "../components/MessageContent";
import { type Emoji } from "../helpers/emoji";
import { useFavoriteEmojis } from "../hooks/use-favorite-emojis";
import { getMentionsLastRead, markMentionsRead } from "../services/read-state";
import { useReadState } from "../hooks/use-read-state";
import type { ChannelMetadata, Role } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { channelViewMode } from "@applesauce/concord/helpers";
import { distinctUntilChanged, map } from "rxjs";
import { ChannelView } from "./channel/ChannelView";
import { ThreadsPanel } from "./channel/ThreadsPanel";
import { useChannelRoster } from "../hooks/use-channel-roster";

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

// Stable empty fallbacks keep slice values at a constant identity before their
// folds emit, avoiding spurious memo/effect invalidation during hydration.
const NO_COMMUNITY_IDS: string[] = [];
const NO_CHANNELS: ChannelMetadata[] = [];
const NO_MEMBERS: ReadonlySet<string> = new Set();
const NO_ROLES: Role[] = [];
const NO_GRANTS: ReadonlyMap<string, string[]> = new Map();

function sameStrings(a: string[], b: string[]) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function Shell() {
  const client = useConcord();
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  // The manager's list contains aggregate CommunityState objects. Project it to
  // stable ids here so a chat/control fold inside one community does not
  // re-render the entire application shell and every community rail item.
  const communityIds =
    use$(() => client.communities$.pipe(map((states) => states.map((state) => state.material.community_id)), distinctUntilChanged(sameStrings)), [client]) ??
    NO_COMMUNITY_IDS;
  const navigate = useNavigate();
  const { cid: cidParam, channelId: channelParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // All navigation state lives in the URL: community/channel in the path,
  // transient modal overlays in the query string.
  const selectedCid = cidParam ?? null;
  const selectedChannel = channelParam ?? null;
  const modal = searchParams.get("modal") as ModalName | null;
  // Settings, community settings, and Direct Invites (CORD-05 §6) are their own
  // routes rendered in the main area (the community rail stays put), not
  // full-screen overlays.
  const { pathname } = useLocation();
  const onInvites = pathname === "/invites";
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
  const dmEnabled = use$(messagesEnabled$);

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
  const activeCommunity = useCommunity(selectedCid ?? undefined);
  const activeChannels = use$(activeCommunity?.channelViews$) ?? NO_CHANNELS;
  const viewingForumPost = Boolean(searchParams.get("post")) && channelViewMode(
    activeChannels.find((channel) => channel.channel_id === selectedChannel),
  ) === "forum";
  const defaultDestination = defaultRoute(
    pathname,
    communityIds[0],
    activeCommunity?.material.community_id,
    activeChannels[0]?.channel_id,
  );
  useEffect(() => {
    if (defaultDestination) navigate(defaultDestination, { replace: true });
  }, [defaultDestination, navigate]);

  return (
    <div className="flex h-screen overflow-hidden max-md:h-[100dvh]">
      {(navOpen || panelMode) && (
        <div className="fixed inset-0 z-[35] bg-black/50 md:hidden" onClick={closeDrawers} />
      )}

      {/* Community rail */}
      <div
        className={`w-18 bg-base-300 flex flex-col items-center py-3 gap-2 overflow-y-auto shrink-0 max-md:fixed max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:safe-rail-y max-md:safe-x max-md:transition-transform ${
          navOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full"
        }`}
      >
        {communityIds.map((cid) => (
          <RailIcon
            key={cid}
            cid={cid}
            active={cid === selectedCid}
            onClick={() => {
              navigate(`/c/${cid}`);
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
        {dmEnabled && <button
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
        </button>}
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
      ) : activeCommunity ? (
        onCommunitySettings ? (
          <CommunitySettingsView
            cid={activeCommunity.material.community_id}
            page={communitySettingsPage}
            mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
            onSelectPage={(p) => navigate(`/c/${activeCommunity.material.community_id}/settings/${p}`)}
            onClose={() => navigate(`/c/${activeCommunity.material.community_id}`)}
          />
        ) : (
        <>
          <div
            className={`md:contents max-md:fixed max-md:inset-y-0 max-md:left-18 max-md:z-40 max-md:safe-fixed-y max-md:transition-transform ${
              navOpen ? "max-md:translate-x-0" : "max-md:-translate-x-[calc(100%+4.5rem)]"
            }`}
          >
            <Sidebar
              cid={activeCommunity.material.community_id}
              selectedChannel={selectedChannel}
              mentionsActive={onMentions}
              onSelectChannel={(id) => {
                navigate(`/c/${activeCommunity.material.community_id}/${id}`);
                setNavOpen(false);
              }}
              onSelectMentions={() => {
                navigate(`/c/${activeCommunity.material.community_id}/mentions`);
                setNavOpen(false);
              }}
              onNewChannel={() => setModal("channel")}
              onInvite={() => setModal("invite")}
              onSettings={() => navigate(`/c/${activeCommunity.material.community_id}/settings`)}
            />
          </div>
          {onMentions ? (
            <MentionsView
              cid={activeCommunity.material.community_id}
              mobileNav={<MobileNavButton onClick={() => setNavOpen(true)} />}
              onOpenChannel={(channelId, msgId) => {
                const url = msgId
                  ? `/c/${activeCommunity.material.community_id}/${channelId}?msg=${msgId}`
                  : `/c/${activeCommunity.material.community_id}/${channelId}`;
                navigate(url);
                setNavOpen(false);
              }}
            />
          ) : selectedChannel ? (
            <ChannelView
              key={`${activeCommunity.material.community_id}:${selectedChannel}`}
              cid={activeCommunity.material.community_id}
              channelId={selectedChannel}
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
          {panelMode && (!viewingForumPost || onMentions) && (
            <SidePanel
              mode={panelMode}
              cid={activeCommunity.material.community_id}
              channelId={selectedChannel}
              threadRootId={threadRootId}
              favorites={favorites}
              onOpenThread={openThread}
              onCloseThread={() => setThreadRootId(null)}
              onClose={() => setPanelMode(null)}
            />
          )}
        </>
        )
      ) : (
        <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
          <div className="h-12 safe-topbar flex items-center px-4 border-b border-base-300 shadow-sm shrink-0 md:hidden">
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
      {modal === "channel" && activeCommunity && (
        <CreateChannelModal cid={activeCommunity.material.community_id} onClose={() => setModal(null)} />
      )}
      {modal === "invite" && activeCommunity && (
        <InviteModal cid={activeCommunity.material.community_id} onClose={() => setModal(null)} />
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

function RailIcon({ cid, active, onClick }: { cid: string; active: boolean; onClick: () => void }) {
  const community = useCommunity(cid);
  const metadata = use$(community?.metadata$);
  const name = metadata?.name ?? community?.material.name ?? "";
  const iconUrl = useDecryptedImage(metadata?.icon);
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
      <CommunityStatusDot cid={cid} />
    </div>
  );
}

// One text-channel row. An unread channel reads at full contrast and semibold
// (an unselected read one is dimmed), with the count as a trailing pill —
// tinted `error` when something in it mentions you, so a mention is findable
// without reading every badge.
/**
 * One channel in the sidebar. Every channel carries chat *and* can host a call
 * (the package models no voice/text split), so a row shows the unread badge and,
 * whenever a call is live in it, the participant count and roster underneath.
 */
function ChannelRow({
  cid,
  channel,
  selected,
  unread,
  onSelect,
}: {
  cid: string;
  channel: ChannelMetadata;
  selected: boolean;
  unread: ChannelUnread | undefined;
  onSelect: () => void;
}) {
  const call = useCall();
  const { fold, roster } = useChannelRoster(cid, channel.channel_id);
  const inThisCall = call.active?.channelId === channel.channel_id && call.active?.cid === cid;
  const inCall = fold.present.length > 0;
  const count = unread?.count ?? 0;
  const has = count > 0;
  return (
    <div className="mb-px">
      <button
        data-channel-row={channel.name}
        className={`flex items-center gap-1.5 px-2 py-1.5 rounded w-full text-left ${
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
        {inThisCall && <span className="w-2 h-2 rounded-full bg-success ml-auto shrink-0" title="You're in this call" />}
        {inCall && (
          <span
            className={`shrink-0 inline-flex items-center gap-0.5 text-[11px] font-semibold text-base-content/60 bg-base-300 rounded-lg px-1.5 py-px ${
              inThisCall ? "ml-1.5" : "ml-auto"
            }`}
            title={`${fold.present.length} in call`}
          >
            <Volume2 size={11} />
            {fold.present.length}
          </span>
        )}
        {has && (
          <span
            data-unread-badge
            data-mention={unread?.mention ? "true" : "false"}
            className={`shrink-0 min-w-5 h-5 px-1 rounded-full text-[11px] font-bold flex items-center justify-center pointer-events-none ${
              inThisCall || inCall ? "ml-1.5" : "ml-auto"
            } ${unread?.mention ? "bg-error text-error-content" : "bg-base-content/20 text-base-content"}`}
            title={`${count} unread message${count === 1 ? "" : "s"}${unread?.mention ? ", mentions you" : ""}`}
          >
            {count > 99 ? "99+" : count}
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

function Sidebar({
  cid,
  selectedChannel,
  mentionsActive,
  onSelectChannel,
  onSelectMentions,
  onNewChannel,
  onInvite,
  onSettings,
}: {
  cid: string;
  selectedChannel: string | null;
  mentionsActive: boolean;
  onSelectChannel: (id: string) => void;
  onSelectMentions: () => void;
  onNewChannel: () => void;
  onInvite: () => void;
  onSettings: () => void;
}) {
  const community = useCommunity(cid);
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const metadata = use$(community?.metadata$);
  const channels = use$(community?.channelViews$) ?? NO_CHANNELS;
  const dissolved = use$(community?.dissolved$) ?? false;
  // The `$` forms, not the `canDo` snapshots: these gate rendered controls, so
  // they have to re-emit when a role grant changes the answer.
  const canManageChannels = use$(() => community?.can$(PERM.MANAGE_CHANNELS), [community]) ?? false;
  const canInvite = use$(() => community?.can$(PERM.CREATE_INVITE), [community]) ?? false;
  const bannerUrl = useDecryptedImage(metadata?.banner);
  const readState = useReadState(pubkey);

  // Every channel carries chat, so every channel can be unread.
  const channelIds = useMemo(() => channels.map((c) => c.channel_id), [channels]);
  const unread = useUnreadCounts(
    community,
    cid,
    channelIds,
    pubkey,
  );

  // Mentions badge: count mentions newer than the mentions cursor. Only channels
  // the user can read are scanned (public + held private channels).
  const readableChannelIds = useMemo(
    () =>
      channels
        .filter((c) => !c.private || community?.material.channels.some((mc) => mc.id === c.channel_id))
        .map((c) => c.channel_id),
    [channels, community],
  );
  const mentionRows = useMentions(community, cid, readableChannelIds, pubkey);
  const mentionsLastRead = getMentionsLastRead(readState, cid);
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
        <span className="truncate" title={cid}>{metadata?.name ?? community?.material.name}</span>
        <div className="flex items-center gap-1 shrink-0">
          <button className="btn btn-ghost btn-sm btn-circle" title="Community settings" onClick={onSettings}>
            <Settings size={18} />
          </button>
        </div>
      </div>
      {dissolved && (
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
          {canManageChannels && !dissolved && (
            <button className="btn btn-ghost btn-xs btn-circle" title="Create channel" onClick={onNewChannel}>
              <Plus size={16} />
            </button>
          )}
        </div>
        {channels.map((ch) => (
          <ChannelRow
            key={ch.channel_id}
            cid={cid}
            channel={ch}
            selected={ch.channel_id === selectedChannel}
            unread={unread[ch.channel_id]}
            onSelect={() => onSelectChannel(ch.channel_id)}
          />
        ))}
        {canInvite && !dissolved && (
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
          <div className="text-[11px] text-base-content/60 truncate">{account?.pubkey === community?.material.owner ? "Owner" : "Member"}</div>
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

function MentionsView({
  cid,
  mobileNav,
  onOpenChannel,
}: {
  cid: string;
  mobileNav: React.ReactNode;
  onOpenChannel: (channelId: string, msgId?: string) => void;
}) {
  const community = useCommunity(cid);
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const metadata = use$(community?.metadata$);
  const channels = use$(community?.channelViews$) ?? NO_CHANNELS;
  const readState = useReadState(pubkey);

  // Only scan text channels the user can read (public + held private channels).
  const readableChannelIds = useMemo(
    () =>
      channels
        .filter((c) => !c.private || community?.material.channels.some((mc) => mc.id === c.channel_id))
        .map((c) => c.channel_id),
    [channels, community],
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
    (channelId: string) => channels.find((c) => c.channel_id === channelId)?.name ?? "unknown",
    [channels],
  );

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base-100 relative">
      <div className="h-12 safe-topbar flex items-center px-4 gap-2 border-b border-base-300 shadow-sm shrink-0">
        {mobileNav}
        <span className="inline-flex items-center text-base-content/60"><AtSign size={20} /></span>
        <span className="font-semibold text-base-content">Mentions</span>
        <span className="text-base-content/60 text-[13px] border-l border-base-300 pl-2 ml-1 max-md:hidden">
          {metadata?.name ?? community?.material.name}
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
            {mentions.map((m, i) => {
              const isNew = m.ms > frozenCursor;
              const nextIsRead = mentions[i + 1]?.ms <= frozenCursor;
              return (
                <Fragment key={m.id}>
                  {isNew && nextIsRead && (
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
  cid,
  channelId,
  threadRootId,
  favorites,
  onOpenThread,
  onCloseThread,
  onClose,
}: {
  mode: "members" | "threads";
  cid: string;
  channelId: string | null;
  threadRootId: string | null;
  favorites: Emoji[];
  onOpenThread: (id: string) => void;
  onCloseThread: () => void;
  onClose: () => void;
}) {
  const community = useCommunity(cid);
  const dissolved = use$(community?.dissolved$) ?? false;
  const title = mode === "members" ? "Members" : threadRootId ? "Thread" : "Threads";
  return (
    <aside className="w-88 shrink-0 flex flex-col bg-base-200 min-h-0 max-md:fixed max-md:inset-y-0 max-md:right-0 max-md:z-40 max-md:w-[min(400px,92vw)] max-md:safe-fixed-y max-md:shadow-2xl">
      <div className="h-12 shrink-0 flex items-center justify-between gap-3 px-4">
        <span className="font-bold text-base-content">{title}</span>
        <button className="btn btn-ghost btn-sm btn-circle" title="Close panel" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {mode === "members" ? (
          <MemberList cid={cid} />
        ) : channelId ? (
          <ThreadsPanel
            cid={cid}
            channelId={channelId}
            threadRootId={threadRootId}
            canWrite={!dissolved}
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

/** A u32 role colour as a CSS hex string, or undefined for the theme default. */
function roleColor(color: number): string | undefined {
  return color ? `#${(color >>> 0).toString(16).padStart(6, "0").slice(-6)}` : undefined;
}

function MemberList({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const membersState = use$(community?.members$) ?? NO_MEMBERS;
  const roles = use$(community?.roles$) ?? NO_ROLES;
  const grants = use$(community?.grants$) ?? NO_GRANTS;
  const banlist = use$(community?.banlist$) ?? NO_MEMBERS;
  const owner = community?.material.owner ?? "";
  const rolesById = useMemo(() => new Map(roles.map((r) => [r.role_id, r])), [roles]);

  // Each member's highest-authority Role (lowest `position`), Discord-style: a
  // member is hoisted under one role only. The owner is special-cased above.
  const primaryRole = useCallback(
    (m: string): Role | undefined => {
      let best: Role | undefined;
      for (const id of grants.get(m) ?? []) {
        const r = rolesById.get(id);
        if (r && (!best || r.position < best.position)) best = r;
      }
      return best;
    },
    [grants, rolesById],
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

  const members = [...membersState];
  const ownerMembers = members.filter((m) => m === owner);
  // Group the rest under their highest role, in authority order (lowest
  // `position` first), then a trailing roleless "Members" section.
  const nonOwner = members.filter((m) => m !== owner);
  const roleless = nonOwner.filter((m) => !primaryRole(m)).sort();
  const sections = [...roles]
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
      {banlist.size > 0 && (
        <>
          <h4 className="text-[11px] uppercase text-error px-2 pb-1.5 mt-3 mb-1">Banned — {banlist.size}</h4>
          {[...banlist].sort().map((m) => (
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
