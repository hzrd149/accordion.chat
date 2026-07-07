import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import {
  DoorOpen,
  Hand,
  Hash,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
  MoreVertical,
  Paperclip,
  Pencil,
  Plus,
  Reply,
  Settings,
  SmilePlus,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { accounts } from "../nostr";
import { ConcordProvider } from "./context";
import { useConcord } from "./concord-context";
import { Login } from "./Login";
import {
  CreateChannelModal,
  CreateCommunityModal,
  InviteModal,
  JoinModal,
  Modal,
  RawEventModal,
} from "./modals";
import { clockTime, colorFor, formatTime, groupMessages } from "./util";
import { UserAvatar, UserName } from "./User";
import { SettingsView } from "./settings";
import { CommunitySettingsView } from "./community-settings";
import { useDecryptedImage } from "./useDecryptedImage";
import { MessageContent } from "./MessageContent";
import { useMentionCandidates, useMentionSearch, detectMention, type MentionCandidate } from "./mentions";
import { EmojiPicker } from "./EmojiPicker";
import { DEFAULT_REACTIONS, useFavoriteEmojis, type Emoji } from "./emoji";
import type { ChatMessage, ConcordClient } from "../concord/client";
import type { CommunityState, Role } from "../concord/types";
import { PERM } from "../concord/types";

export function App() {
  const account = useActiveAccount();
  if (!account) return <Login />;
  return (
    <ConcordProvider>
      {() => (
        <Routes>
          <Route path="/" element={<Shell />} />
          <Route path="/c/:cid" element={<Shell />} />
          <Route path="/c/:cid/:channelId" element={<Shell />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      )}
    </ConcordProvider>
  );
}

/** Overlay names carried in the `?modal=` query param. */
type ModalName = "create" | "join" | "channel" | "invite" | "addMenu" | "leave";

// Stable empty fallback so `communities` keeps a constant identity while the
// stream is still empty — otherwise a fresh `[]` each render would retrigger the
// auto-select effect below on every render.
const NO_COMMUNITIES: CommunityState[] = [];

function Shell() {
  const client = useConcord();
  const communities = use$(client.communities$) ?? NO_COMMUNITIES;
  const status = use$(client.status$);
  const navigate = useNavigate();
  const { cid: cidParam, channelId: channelParam } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();

  // All navigation state lives in the URL: community/channel in the path,
  // transient overlays (modals + settings) in the query string.
  const selectedCid = cidParam ?? null;
  const selectedChannel = channelParam ?? null;
  const modal = searchParams.get("modal") as ModalName | null;
  const settingsPage = searchParams.get("settings");
  const adminPage = searchParams.get("admin");

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

  const [leaving, setLeaving] = useState(false);
  // Mobile off-canvas drawers (ignored by CSS above the tablet breakpoint).
  const [navOpen, setNavOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const closeDrawers = () => {
    setNavOpen(false);
    setMembersOpen(false);
  };

  // Auto-select a community and channel as they arrive, reflecting the choice
  // into the URL (replace, so it doesn't clutter history).
  const activeState = communities.find((c) => c.material.community_id === selectedCid);
  useEffect(() => {
    if (communities.length === 0) {
      if (selectedCid) navigate("/", { replace: true });
      return;
    }
    if (!selectedCid || !communities.some((c) => c.material.community_id === selectedCid)) {
      navigate(`/c/${communities[0].material.community_id}`, { replace: true });
    }
  }, [communities, selectedCid, navigate]);

  useEffect(() => {
    if (!activeState) return;
    const channels = activeState.channels;
    if (channels.length && (!selectedChannel || !channels.some((c) => c.channel_id === selectedChannel))) {
      navigate(`/c/${activeState.material.community_id}/${channels[0].channel_id}`, { replace: true });
    }
  }, [activeState, selectedChannel, navigate]);

  return (
    <div className={`app${navOpen ? " nav-open" : ""}${membersOpen ? " members-open" : ""}`}>
      {/* Mobile-only drawer controls (hidden by CSS on larger screens). */}
      <button className="drawer-toggle nav" title="Menu" onClick={() => setNavOpen((v) => !v)}>
        <Menu size={22} />
      </button>
      {activeState && (
        <button className="drawer-toggle members" title="Members" onClick={() => setMembersOpen((v) => !v)}>
          <Users size={22} />
        </button>
      )}
      <div className="drawer-backdrop" onClick={closeDrawers} />

      {/* Community rail */}
      <div className="rail">
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
        <div className="rail-divider" />
        <button className="rail-icon add" title="Add a community" onClick={() => setModal("addMenu")}>
          <Plus size={24} />
        </button>
        <button
          className="rail-icon settings-gear"
          title="Settings"
          style={{ marginTop: "auto" }}
          onClick={() => setParam("settings", "profile")}
        >
          <Settings size={22} />
        </button>
      </div>

      {activeState ? (
        <>
          <Sidebar
            state={activeState}
            selectedChannel={selectedChannel}
            onSelectChannel={(id) => {
              navigate(`/c/${activeState.material.community_id}/${id}`);
              setNavOpen(false);
            }}
            onNewChannel={() => setModal("channel")}
            onInvite={() => setModal("invite")}
            onSettings={() => setParam("admin", "overview")}
            onLeave={() => setModal("leave")}
          />
          {selectedChannel ? (
            <ChatView cid={activeState.material.community_id} channelId={selectedChannel} state={activeState} />
          ) : (
            <div className="main">
              <div className="empty">
                <div className="big"><MessageSquare size={48} /></div>
                <div>Select or create a channel to start chatting.</div>
              </div>
            </div>
          )}
          <MemberList state={activeState} />
        </>
      ) : (
        <div className="main">
          <div className="empty">
            <div className="big app-emoji-icon" aria-hidden="true">🪗</div>
            <h2 style={{ color: "var(--text-bright)", margin: 0 }}>Welcome to Appcordion</h2>
            <div>Create your own community or join one with an invite link.</div>
            <div style={{ display: "flex", gap: 12, marginTop: 12 }}>
              <button className="btn" onClick={() => setModal("create")}>
                Create a community
              </button>
              <button className="btn ghost" onClick={() => setModal("join")}>
                Join with a link
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      {modal === "addMenu" && (
        <Modal onClose={() => setModal(null)}>
          <h2>Add a community</h2>
          <button className="btn full" onClick={() => setModal("create")}>
            Create my own
          </button>
          <button className="btn full ghost" onClick={() => setModal("join")}>
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
      {modal === "join" && (
        <JoinModal onClose={() => setModal(null)} onJoined={(id) => navigate(`/c/${id}`)} />
      )}
      {modal === "channel" && activeState && (
        <CreateChannelModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
      )}
      {modal === "invite" && activeState && (
        <InviteModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
      )}
      {modal === "leave" && activeState && (
        <Modal onClose={() => (leaving ? undefined : setModal(null))}>
          <h2>Leave {activeState.metadata?.name ?? activeState.material.name}?</h2>
          <p style={{ color: "var(--text-muted)" }}>
            You'll be removed from this community and it will disappear from your list. You can
            rejoin later with an invite link.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
            <button
              className="btn danger"
              disabled={leaving}
              onClick={async () => {
                const cid = activeState.material.community_id;
                setLeaving(true);
                try {
                  await client.leave(cid);
                  navigate("/");
                } finally {
                  setLeaving(false);
                }
              }}
            >
              {leaving ? "Leaving…" : "Leave community"}
            </button>
            <button className="btn ghost" disabled={leaving} onClick={() => setModal(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}

      {settingsPage !== null && (
        <SettingsView
          page={settingsPage}
          onSelectPage={(p) => setParam("settings", p)}
          onClose={() => setParam("settings", null)}
        />
      )}

      {adminPage !== null && activeState && (
        <CommunitySettingsView
          cid={activeState.material.community_id}
          page={adminPage}
          onSelectPage={(p) => setParam("admin", p)}
          onClose={() => setParam("admin", null)}
        />
      )}

      {status && <div className="status-toast">{status}</div>}
    </div>
  );
}

function RailIcon({ state, active, onClick }: { state: CommunityState; active: boolean; onClick: () => void }) {
  const name = state.metadata?.name ?? state.material.name;
  const iconUrl = useDecryptedImage(state.metadata?.icon);
  return (
    <button
      className={`rail-icon ${active ? "active" : ""}${iconUrl ? " has-image" : ""}`}
      title={name}
      onClick={onClick}
    >
      {iconUrl ? <img src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
    </button>
  );
}

function Sidebar({
  state,
  selectedChannel,
  onSelectChannel,
  onNewChannel,
  onInvite,
  onSettings,
  onLeave,
}: {
  state: CommunityState;
  selectedChannel: string | null;
  onSelectChannel: (id: string) => void;
  onNewChannel: () => void;
  onInvite: () => void;
  onSettings: () => void;
  onLeave: () => void;
}) {
  const client = useConcord();
  const account = useActiveAccount();
  const canManageChannels = client.canDo(state.material.community_id, PERM.MANAGE_CHANNELS);
  const canInvite = client.canDo(state.material.community_id, PERM.CREATE_INVITE);
  const bannerUrl = useDecryptedImage(state.metadata?.banner);

  return (
    <div className="sidebar">
      {bannerUrl && <div className="sidebar-banner" style={{ backgroundImage: `url(${bannerUrl})` }} />}
      <div className={`sidebar-header${bannerUrl ? " has-banner" : ""}`}>
        <span title={state.material.community_id}>{state.metadata?.name ?? state.material.name}</span>
        <div className="sidebar-header-actions">
          <button title="Community settings" onClick={onSettings}>
            <Settings size={18} />
          </button>
          <button title="Leave community" onClick={onLeave}>
            <DoorOpen size={18} />
          </button>
        </div>
      </div>
      {state.dissolved && (
        <div className="error" style={{ padding: 12 }}>
          This community has been dissolved. It is now read-only.
        </div>
      )}
      <div className="channel-list">
        <div className="channel-cat">
          <span>Channels</span>
          {canManageChannels && !state.dissolved && (
            <button title="Create channel" onClick={onNewChannel}>
              <Plus size={16} />
            </button>
          )}
        </div>
        {state.channels.map((ch) => (
          <button
            key={ch.channel_id}
            className={`channel ${ch.channel_id === selectedChannel ? "active" : ""}`}
            onClick={() => onSelectChannel(ch.channel_id)}
          >
            <span className="hash">{ch.private ? <Lock size={16} /> : <Hash size={16} />}</span>
            <span>{ch.name}</span>
          </button>
        ))}
        {canInvite && !state.dissolved && (
          <button className="channel" style={{ marginTop: 12, color: "var(--success)" }} onClick={onInvite}>
            <span className="hash"><UserPlus size={16} /></span>
            <span>Invite people</span>
          </button>
        )}
      </div>
      <div className="account-bar">
        <UserAvatar pubkey={account?.pubkey ?? ""} />
        <div className="who">
          <div className="name">
            <UserName pubkey={account?.pubkey ?? ""} />
          </div>
          <div className="sub">{account?.pubkey === state.material.owner ? "Owner" : "Member"}</div>
        </div>
        <button
          className="logout"
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

type ReplyTarget = { id: string; author: string };

/** Render a quick-reaction label: a unicode char, or a custom emoji image. */
function reactionLabel(r: string | Emoji) {
  return typeof r === "string" ? (
    r
  ) : (
    <img className="inline-emoji" src={r.url} alt={`:${r.shortcode}:`} loading="lazy" />
  );
}

// The chat view is split into three independently-rendering pieces so a keystroke
// in the composer never re-renders the (potentially long) message list:
//   • ChatView    — owns the message stream, scroll, and shared reply target.
//   • MessageList — memoized; re-renders only when the messages/groups change.
//   • Composer    — owns the draft text/files/sending/picker state locally.
function ChatView({ cid, channelId, state }: { cid: string; channelId: string; state: CommunityState }) {
  const client = useConcord();
  const messages = (use$(() => client.getMessages$(cid, channelId), [cid, channelId]) ?? []) as ChatMessage[];
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // The user's NIP-30 favorite custom emojis (kind 10030 + referenced packs).
  const favorites = useFavoriteEmojis(client.pubkey);
  // Quick-react buttons: lead with the user's favorites, backfill with defaults.
  // Memoized so the reference stays stable and doesn't defeat MessageList's memo.
  const quickReactions = useMemo<(string | Emoji)[]>(
    () => [...favorites.slice(0, 3), ...DEFAULT_REACTIONS.slice(0, favorites.length >= 3 ? 2 : 3)],
    [favorites],
  );

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

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
    async (value: string, files: File[], reply: ReplyTarget | null) => {
      setReplyTo(null);
      await client.sendMessage(cid, channelId, value, reply ?? undefined, files.length ? files : undefined, favorites);
    },
    [client, cid, channelId, favorites],
  );

  return (
    <div className="main">
      <div className="main-header">
        <span className="hash" style={{ color: "var(--text-muted)" }}>
          {channel?.private ? <Lock size={20} /> : <Hash size={20} />}
        </span>
        <span className="title">{channel?.name}</span>
        <span className="topic">{state.metadata?.description}</span>
        <div className="spacer" />
      </div>
      <MessageList
        ref={scrollRef}
        messages={messages}
        channelName={channel?.name}
        ownerPubkey={state.material.owner}
        myPubkey={client.pubkey}
        canWrite={canWrite}
        client={client}
        cid={cid}
        channelId={channelId}
        favorites={favorites}
        quickReactions={quickReactions}
        onReply={setReplyTo}
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

const MessageList = memo(function MessageList({
  ref,
  messages,
  channelName,
  ownerPubkey,
  myPubkey,
  canWrite,
  client,
  cid,
  channelId,
  favorites,
  quickReactions,
  onReply,
}: {
  ref: React.Ref<HTMLDivElement>;
  messages: ChatMessage[];
  channelName: string | undefined;
  ownerPubkey: string;
  myPubkey: string;
  canWrite: boolean;
  client: ConcordClient;
  cid: string;
  channelId: string;
  favorites: Emoji[];
  quickReactions: (string | Emoji)[];
  onReply: (r: ReplyTarget) => void;
}) {
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // Collapse consecutive messages from the same author (within 2 min) into one
  // avatar group — Discord/Slack style. Replies always start a fresh header.
  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className="content-row">
      <div className="messages" ref={ref}>
        <div className="filler" />
        {messages.length === 0 && (
          <div className="empty">
            <div className="big"><Hand size={48} /></div>
            <div>This is the beginning of #{channelName}. Say hello!</div>
          </div>
        )}
        {groups.map((group) => (
          <div className="msg-group" key={group[0].id}>
            {group.map((m, i) => (
              <Message
                key={m.id}
                m={m}
                showHeader={i === 0 || Boolean(m.replyTo)}
                replyPreview={m.replyTo ? byId.get(m.replyTo.id)?.content ?? "message" : undefined}
                ownerPubkey={ownerPubkey}
                myPubkey={myPubkey}
                canWrite={canWrite}
                client={client}
                cid={cid}
                channelId={channelId}
                favorites={favorites}
                quickReactions={quickReactions}
                onReply={onReply}
              />
            ))}
          </div>
        ))}
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
  client,
  cid,
  channelId,
  favorites,
  quickReactions,
  onReply,
}: {
  m: ChatMessage;
  showHeader: boolean;
  replyPreview: string | undefined;
  ownerPubkey: string;
  myPubkey: string;
  canWrite: boolean;
  client: ConcordClient;
  cid: string;
  channelId: string;
  favorites: Emoji[];
  quickReactions: (string | Emoji)[];
  onReply: (r: ReplyTarget) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const react = (reaction: string | Emoji) => client.react(cid, channelId, { id: m.id, author: m.author }, reaction);

  async function saveEdit() {
    const value = editText.trim();
    setEditing(false);
    if (value) await client.editMessage(cid, channelId, m.id, value);
  }

  return (
    <div className={`msg${showHeader ? "" : " continued"}`} tabIndex={-1}>
      {showHeader ? (
        <UserAvatar pubkey={m.author} />
      ) : (
        <div className="msg-gutter">
          <span className="time">{clockTime(m.ms)}</span>
        </div>
      )}
      <div className="msg-body">
        {m.replyTo && (
          <div className="msg-reply">
            <Reply size={14} /> <UserName pubkey={m.replyTo.author} />: {replyPreview}
          </div>
        )}
        {showHeader && (
          <div className="msg-head">
            <span className="name" style={{ color: colorFor(m.author) }}>
              <UserName pubkey={m.author} />
            </span>
            <span className="time">{formatTime(m.ms)}</span>
            {m.author === ownerPubkey && <span className="badge owner">Owner</span>}
          </div>
        )}
        {editing ? (
          <input
            className="field"
            style={{ width: "100%" }}
            value={editText}
            autoFocus
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") saveEdit();
              if (e.key === "Escape") setEditing(false);
            }}
          />
        ) : m.deleted ? (
          <div className="msg-text deleted">(message deleted)</div>
        ) : (
          <>
            <MessageContent text={m.edited ?? m.content} attachments={m.attachments} emojiTags={m.emojiTags} />
            {m.edited && <span className="time"> (edited)</span>}
          </>
        )}
        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button
                key={r.emoji}
                className={`reaction ${r.authors.includes(myPubkey) ? "mine" : ""}`}
                // Re-react: reconstruct the custom emoji from its URL, else the unicode content.
                onClick={() => react(r.url ? { shortcode: r.emoji.replace(/^:|:$/g, ""), url: r.url } : r.emoji)}
              >
                {r.url ? (
                  <img className="inline-emoji" src={r.url} alt={r.emoji} title={r.emoji} loading="lazy" />
                ) : (
                  r.emoji
                )}{" "}
                {r.count}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="msg-actions">
        {canWrite && (
          <>
            {quickReactions.map((e) => (
              <button
                key={typeof e === "string" ? e : e.shortcode}
                title={typeof e === "string" ? e : `:${e.shortcode}:`}
                onClick={() => react(e)}
              >
                {reactionLabel(e)}
              </button>
            ))}
            <span className="picker-anchor">
              <button title="React…" onClick={() => setPickerOpen((v) => !v)}>
                <SmilePlus size={16} />
              </button>
              {pickerOpen && (
                <EmojiPicker favorites={favorites} onPick={react} onClose={() => setPickerOpen(false)} />
              )}
            </span>
            <button title="Reply" onClick={() => onReply({ id: m.id, author: m.author })}>
              <Reply size={16} />
            </button>
            {m.author === myPubkey && !m.deleted && (
              <>
                <button
                  title="Edit"
                  onClick={() => {
                    setEditText(m.edited ?? m.content);
                    setEditing(true);
                  }}
                >
                  <Pencil size={16} />
                </button>
                <button title="Delete" onClick={() => client.deleteMessage(cid, channelId, m.id)}>
                  <Trash2 size={16} />
                </button>
              </>
            )}
          </>
        )}
        <span className="picker-anchor">
          <button title="More" onClick={() => setMenuOpen((v) => !v)}>
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
    <div className="msg-menu right" ref={ref}>
      <button onClick={onViewRaw}>View raw</button>
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
  onSend: (text: string, files: File[], reply: ReplyTarget | null) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  async function send() {
    const value = text.trim();
    if (!value && files.length === 0) return;
    const attach = files;
    const reply = replyTo;
    setText("");
    setMention(null);
    setFiles([]);
    setSending(true);
    try {
      await onSend(value, attach, reply);
    } catch (err) {
      console.error("send failed", err);
      // Restore the draft so the user doesn't lose their message/attachments.
      setText(value);
      setFiles(attach);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="composer">
      {replyTo && (
        <div className="reply-bar">
          <span>
            Replying to <UserName pubkey={replyTo.author} />
          </span>
          <button onClick={onClearReply}><X size={16} /></button>
        </div>
      )}
      {files.length > 0 && (
        <div className="attach-bar">
          {files.map((f, i) => (
            <span className="attach-chip" key={i} title={f.name}>
              📎 {f.name}
              <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}>
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="box">
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
        <button className="attach" title="Attach files" onClick={() => fileInputRef.current?.click()}>
          <Paperclip size={20} />
        </button>
        <span className="picker-anchor">
          <button className="attach" title="Emoji" onClick={() => setPickerOpen((v) => !v)}>
            <SmilePlus size={20} />
          </button>
          {pickerOpen && (
            <EmojiPicker
              favorites={favorites}
              align="right"
              onPick={(e) => setText((t) => `${t}${typeof e === "string" ? e : `:${e.shortcode}:`}`)}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </span>
        {mentionOpen && (
          <ul className="mention-menu" role="listbox">
            {mentionResults.map((c, i) => (
              <li key={c.pubkey} role="option" aria-selected={i === activeIndex}>
                <button
                  type="button"
                  className={`mention-item${i === activeIndex ? " active" : ""}`}
                  // Keep textarea focus so `onBlur`-free selection still works.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => insertMention(c)}
                >
                  {c.picture ? (
                    <img className="avatar" src={c.picture} alt="" />
                  ) : (
                    <span className="avatar" style={{ background: colorFor(c.pubkey) }}>
                      {c.name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <span className="m-name">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={1}
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
        <button className="send" onClick={send} disabled={sending}>
          {sending ? "Sending…" : "Send"}
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
    <div className="member" key={m} title={m}>
      <UserAvatar pubkey={m} />
      <span className="m-name" style={role ? { color: roleColor(role.color) } : undefined}>
        <UserName pubkey={m} />
      </span>
      {m === owner ? (
        <span className="badge owner">Owner</span>
      ) : (
        role && (
          <span className="badge role" style={{ background: roleColor(role.color) }}>
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
    <div className="members">
      {ownerMembers.length > 0 && (
        <>
          <h4>Owner</h4>
          {ownerMembers.map((m) => row(m))}
        </>
      )}
      {sections.map((s) => (
        <div key={s.role.role_id}>
          <h4 style={{ color: roleColor(s.role.color) }}>
            {s.role.name} — {s.members.length}
          </h4>
          {s.members.map((m) => row(m, s.role))}
        </div>
      ))}
      <h4>Members — {roleless.length}</h4>
      {roleless.map((m) => row(m))}
      {members.length === 0 && <p className="sub" style={{ padding: 8 }}>No members yet.</p>}
    </div>
  );
}
