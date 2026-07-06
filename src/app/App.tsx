import { useEffect, useMemo, useRef, useState } from "react";
import {
  DoorOpen,
  Hand,
  Hash,
  Lock,
  LogOut,
  MessageSquare,
  Landmark,
  Pencil,
  Plus,
  Reply,
  Settings,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { accounts } from "../nostr";
import { ConcordProvider, useConcord } from "./context";
import { Login } from "./Login";
import {
  AdminModal,
  CreateChannelModal,
  CreateCommunityModal,
  InviteModal,
  JoinModal,
  Modal,
} from "./modals";
import { clockTime, colorFor, formatTime, groupMessages } from "./util";
import { UserAvatar, UserName } from "./User";
import type { ChatMessage } from "../concord/client";
import type { CommunityState } from "../concord/types";
import { PERM } from "../concord/types";

const EMOJIS = ["👍", "❤️", "😂", "🔥", "🎉", "😮"];

export function App() {
  const account = useActiveAccount();
  if (!account) return <Login />;
  return <ConcordProvider>{() => <Shell />}</ConcordProvider>;
}

function Shell() {
  const client = useConcord();
  const communities = use$(client.communities$) ?? [];
  const status = use$(client.status$);
  const [selectedCid, setSelectedCid] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [modal, setModal] = useState<
    null | "create" | "join" | "channel" | "invite" | "admin" | "addMenu" | "leave"
  >(null);
  const [leaving, setLeaving] = useState(false);

  // Auto-select a community and channel as they arrive.
  const activeState = communities.find((c) => c.material.community_id === selectedCid);
  useEffect(() => {
    if (!selectedCid && communities.length) setSelectedCid(communities[0].material.community_id);
    if (selectedCid && !communities.some((c) => c.material.community_id === selectedCid)) {
      setSelectedCid(communities[0]?.material.community_id ?? null);
      setSelectedChannel(null);
    }
  }, [communities, selectedCid]);

  useEffect(() => {
    if (!activeState) return;
    const channels = activeState.channels;
    if (channels.length && (!selectedChannel || !channels.some((c) => c.channel_id === selectedChannel))) {
      setSelectedChannel(channels[0].channel_id);
    }
  }, [activeState, selectedChannel]);

  return (
    <div className="app">
      {/* Community rail */}
      <div className="rail">
        {communities.map((c) => (
          <button
            key={c.material.community_id}
            className={`rail-icon ${c.material.community_id === selectedCid ? "active" : ""}`}
            title={c.metadata?.name ?? c.material.name}
            onClick={() => setSelectedCid(c.material.community_id)}
          >
            {(c.metadata?.name ?? c.material.name).slice(0, 2).toUpperCase()}
          </button>
        ))}
        <div className="rail-divider" />
        <button className="rail-icon add" title="Add a community" onClick={() => setModal("addMenu")}>
          <Plus size={24} />
        </button>
      </div>

      {activeState ? (
        <>
          <Sidebar
            state={activeState}
            selectedChannel={selectedChannel}
            onSelectChannel={setSelectedChannel}
            onNewChannel={() => setModal("channel")}
            onInvite={() => setModal("invite")}
            onSettings={() => setModal("admin")}
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
            <div className="big"><Landmark size={48} /></div>
            <h2 style={{ color: "var(--text-bright)", margin: 0 }}>Welcome to Concord</h2>
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
          onCreated={(id) => {
            setSelectedCid(id);
            setSelectedChannel(null);
            setModal(null);
          }}
        />
      )}
      {modal === "join" && (
        <JoinModal
          onClose={() => setModal(null)}
          onJoined={(id) => {
            setSelectedCid(id);
            setSelectedChannel(null);
            setModal(null);
          }}
        />
      )}
      {modal === "channel" && activeState && (
        <CreateChannelModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
      )}
      {modal === "invite" && activeState && (
        <InviteModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
      )}
      {modal === "admin" && activeState && (
        <AdminModal cid={activeState.material.community_id} onClose={() => setModal(null)} />
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
                  setSelectedChannel(null);
                  setModal(null);
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

      {status && <div className="status-toast">{status}</div>}
    </div>
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

  return (
    <div className="sidebar">
      <div className="sidebar-header">
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
  const scrollRef = useRef<HTMLDivElement>(null);

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
    if (!value) return;
    setText("");
    const reply = replyTo ?? undefined;
    setReplyTo(null);
    await client.sendMessage(cid, channelId, value, reply);
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
                  <div className={`msg${showHeader ? "" : " continued"}`} key={m.id}>
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
                        <div className="msg-text">
                          {m.edited ?? m.content}
                          {m.edited && <span className="time"> (edited)</span>}
                        </div>
                      )}
                      {m.reactions.length > 0 && (
                        <div className="reactions">
                          {m.reactions.map((r) => (
                            <button
                              key={r.emoji}
                              className={`reaction ${r.authors.includes(client.pubkey) ? "mine" : ""}`}
                              onClick={() => client.react(cid, channelId, { id: m.id, author: m.author }, r.emoji)}
                            >
                              {r.emoji} {r.count}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {canWrite && (
                      <div className="msg-actions">
                        {EMOJIS.slice(0, 3).map((e) => (
                          <button key={e} onClick={() => client.react(cid, channelId, { id: m.id, author: m.author }, e)}>
                            {e}
                          </button>
                        ))}
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
          <div className="box">
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
            <button className="send" onClick={send}>
              Send
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
