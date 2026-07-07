import { useEffect, useMemo, useRef, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router";
import {
  DoorOpen,
  Hand,
  Hash,
  Lock,
  LogOut,
  Menu,
  MessageSquare,
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
import { ConcordProvider, useConcord } from "./context";
import { Login } from "./Login";
import {
  CreateChannelModal,
  CreateCommunityModal,
  InviteModal,
  JoinModal,
  Modal,
} from "./modals";
import { clockTime, colorFor, formatTime, groupMessages } from "./util";
import { UserAvatar, UserName } from "./User";
import { SettingsView } from "./settings";
import { CommunitySettingsView } from "./community-settings";
import { useDecryptedImage } from "./useDecryptedImage";
import { MessageContent } from "./MessageContent";
import { EmojiPicker } from "./EmojiPicker";
import { DEFAULT_REACTIONS, useFavoriteEmojis, type Emoji } from "./emoji";
import type { ChatMessage } from "../concord/client";
import type { CommunityState } from "../concord/types";
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

function Shell() {
  const client = useConcord();
  const communities = use$(client.communities$) ?? [];
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

function ChatView({ cid, channelId, state }: { cid: string; channelId: string; state: CommunityState }) {
  const client = useConcord();
  const messages = (use$(() => client.getMessages$(cid, channelId), [cid, channelId]) ?? []) as ChatMessage[];
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; author: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  // Which message's reaction picker is open (by id), or "composer" for the composer's.
  const [picker, setPicker] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The user's NIP-30 favorite custom emojis (kind 10030 + referenced packs).
  const favorites = useFavoriteEmojis(client.pubkey);
  // Quick-react buttons: lead with the user's favorites, backfill with defaults.
  const quickReactions: (string | Emoji)[] = [
    ...favorites.slice(0, 3),
    ...DEFAULT_REACTIONS.slice(0, favorites.length >= 3 ? 2 : 3),
  ];

  const doReact = (m: ChatMessage, reaction: string | Emoji) =>
    client.react(cid, channelId, { id: m.id, author: m.author }, reaction);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  useEffect(() => {
    setReplyTo(null);
    setText("");
  }, [channelId]);

  const canWrite = !state.dissolved;

  async function send() {
    const value = text.trim();
    if (!value && files.length === 0) return;
    const reply = replyTo ?? undefined;
    const attach = files;
    setText("");
    setReplyTo(null);
    setFiles([]);
    setSending(true);
    try {
      await client.sendMessage(cid, channelId, value, reply, attach.length ? attach : undefined, favorites);
    } catch (err) {
      console.error("send failed", err);
      // Restore the draft so the user doesn't lose their message/attachments.
      setText(value);
      setFiles(attach);
    } finally {
      setSending(false);
    }
  }

  async function saveEdit(id: string) {
    const value = editText.trim();
    setEditing(null);
    if (value) await client.editMessage(cid, channelId, id, value);
  }

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // Collapse consecutive messages from the same author (within 2 min) into one
  // avatar group — Discord/Slack style. Replies always start a fresh header.
  const groups = useMemo(() => groupMessages(messages), [messages]);

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
      <div className="content-row">
        <div className="messages" ref={scrollRef}>
          <div className="filler" />
          {messages.length === 0 && (
            <div className="empty">
              <div className="big"><Hand size={48} /></div>
              <div>This is the beginning of #{channel?.name}. Say hello!</div>
            </div>
          )}
          {groups.map((group) => (
            <div className="msg-group" key={group[0].id}>
              {group.map((m, i) => {
                const showHeader = i === 0 || Boolean(m.replyTo);
                return (
                  <div className={`msg${showHeader ? "" : " continued"}`} key={m.id} tabIndex={-1}>
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
                          <Reply size={14} /> <UserName pubkey={m.replyTo.author} />: {byId.get(m.replyTo.id)?.content ?? "message"}
                        </div>
                      )}
                      {showHeader && (
                      <div className="msg-head">
                        <span className="name" style={{ color: colorFor(m.author) }}>
                          <UserName pubkey={m.author} />
                        </span>
                        <span className="time">{formatTime(m.ms)}</span>
                        {m.author === state.material.owner && <span className="badge owner">Owner</span>}
                      </div>
                      )}
                      {editing === m.id ? (
                        <input
                          className="field"
                          style={{ width: "100%" }}
                          value={editText}
                          autoFocus
                          onChange={(e) => setEditText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") saveEdit(m.id);
                            if (e.key === "Escape") setEditing(null);
                          }}
                        />
                      ) : m.deleted ? (
                        <div className="msg-text deleted">(message deleted)</div>
                      ) : (
                        <>
                          <MessageContent
                            text={m.edited ?? m.content}
                            attachments={m.attachments}
                            emojiTags={m.emojiTags}
                          />
                          {m.edited && <span className="time"> (edited)</span>}
                        </>
                      )}
                      {m.reactions.length > 0 && (
                        <div className="reactions">
                          {m.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              className={`reaction ${r.authors.includes(client.pubkey) ? "mine" : ""}`}
                              // Re-react: reconstruct the custom emoji from its URL, else the unicode content.
                              onClick={() =>
                                doReact(m, r.url ? { shortcode: r.emoji.replace(/^:|:$/g, ""), url: r.url } : r.emoji)
                              }
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
                    {canWrite && (
                      <div className="msg-actions">
                        {quickReactions.map((e) => (
                          <button
                            key={typeof e === "string" ? e : e.shortcode}
                            title={typeof e === "string" ? e : `:${e.shortcode}:`}
                            onClick={() => doReact(m, e)}
                          >
                            {typeof e === "string" ? (
                              e
                            ) : (
                              <img className="inline-emoji" src={e.url} alt={`:${e.shortcode}:`} loading="lazy" />
                            )}
                          </button>
                        ))}
                        <span className="picker-anchor">
                          <button
                            title="React…"
                            onClick={() => setPicker((p) => (p === m.id ? null : m.id))}
                          >
                            <SmilePlus size={16} />
                          </button>
                          {picker === m.id && (
                            <EmojiPicker
                              favorites={favorites}
                              onPick={(reaction) => doReact(m, reaction)}
                              onClose={() => setPicker(null)}
                            />
                          )}
                        </span>
                        <button title="Reply" onClick={() => setReplyTo({ id: m.id, author: m.author })}>
                          <Reply size={16} />
                        </button>
                        {m.author === client.pubkey && !m.deleted && (
                          <>
                            <button
                              title="Edit"
                              onClick={() => {
                                setEditing(m.id);
                                setEditText(m.edited ?? m.content);
                              }}
                            >
                              <Pencil size={16} />
                            </button>
                            <button title="Delete" onClick={() => client.deleteMessage(cid, channelId, m.id)}>
                              <Trash2 size={16} />
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      {canWrite && (
        <div className="composer">
          {replyTo && (
            <div className="reply-bar">
              <span>
                Replying to <UserName pubkey={replyTo.author} />
              </span>
              <button onClick={() => setReplyTo(null)}><X size={16} /></button>
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
              <button
                className="attach"
                title="Emoji"
                onClick={() => setPicker((p) => (p === "composer" ? null : "composer"))}
              >
                <SmilePlus size={20} />
              </button>
              {picker === "composer" && (
                <EmojiPicker
                  favorites={favorites}
                  align="right"
                  onPick={(e) => setText((t) => `${t}${typeof e === "string" ? e : `:${e.shortcode}:`}`)}
                  onClose={() => setPicker(null)}
                />
              )}
            </span>
            <textarea
              rows={1}
              placeholder={`Message ${channel?.private ? "🔒" : "#"}${channel?.name ?? ""}`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
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
      )}
    </div>
  );
}

function MemberList({ state }: { state: CommunityState }) {
  const members = [...state.members];
  const owner = members.filter((m) => m === state.material.owner);
  const others = members.filter((m) => m !== state.material.owner).sort();

  const row = (m: string) => (
    <div className="member" key={m} title={m}>
      <UserAvatar pubkey={m} />
      <span className="m-name">
        <UserName pubkey={m} />
      </span>
      {m === state.material.owner && <span className="badge owner">Owner</span>}
    </div>
  );

  return (
    <div className="members">
      <h4>Owner</h4>
      {owner.map(row)}
      <h4>Members — {others.length}</h4>
      {others.map(row)}
      {members.length === 0 && <p className="sub" style={{ padding: 8 }}>No members yet.</p>}
    </div>
  );
}
