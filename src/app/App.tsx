import { useEffect, useMemo, useRef, useState } from "react";
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
import { colorFor, displayName, formatTime, initials } from "./util";
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
  const [modal, setModal] = useState<null | "create" | "join" | "channel" | "invite" | "admin" | "addMenu">(null);

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
          +
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
          />
          {selectedChannel ? (
            <ChatView cid={activeState.material.community_id} channelId={selectedChannel} state={activeState} />
          ) : (
            <div className="main">
              <div className="empty">
                <div className="big">💬</div>
                <div>Select or create a channel to start chatting.</div>
              </div>
            </div>
          )}
          <MemberList state={activeState} />
        </>
      ) : (
        <div className="main">
          <div className="empty">
            <div className="big">🏛️</div>
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
}: {
  state: CommunityState;
  selectedChannel: string | null;
  onSelectChannel: (id: string) => void;
  onNewChannel: () => void;
  onInvite: () => void;
  onSettings: () => void;
}) {
  const client = useConcord();
  const account = useActiveAccount();
  const canManageChannels = client.canDo(state.material.community_id, PERM.MANAGE_CHANNELS);
  const canInvite = client.canDo(state.material.community_id, PERM.CREATE_INVITE);

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span title={state.material.community_id}>{state.metadata?.name ?? state.material.name}</span>
        <button title="Community settings" onClick={onSettings}>
          ⚙
        </button>
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
              +
            </button>
          )}
        </div>
        {state.channels.map((ch) => (
          <button
            key={ch.channel_id}
            className={`channel ${ch.channel_id === selectedChannel ? "active" : ""}`}
            onClick={() => onSelectChannel(ch.channel_id)}
          >
            <span className="hash">{ch.private ? "🔒" : "#"}</span>
            <span>{ch.name}</span>
          </button>
        ))}
        {canInvite && !state.dissolved && (
          <button className="channel" style={{ marginTop: 12, color: "var(--success)" }} onClick={onInvite}>
            <span>➕ Invite people</span>
          </button>
        )}
      </div>
      <div className="account-bar">
        <div className="avatar" style={{ background: colorFor(account?.pubkey ?? "") }}>
          {initials(account?.pubkey ?? "")}
        </div>
        <div className="who">
          <div className="name">{displayName(account?.pubkey ?? "")}</div>
          <div className="sub">{account?.pubkey === state.material.owner ? "Owner" : "Member"}</div>
        </div>
        <button
          className="logout"
          title="Sign out"
          onClick={() => {
            if (account) accounts.removeAccount(account);
          }}
        >
          ⎋
        </button>
      </div>
    </div>
  );
}

function ChatView({ cid, channelId, state }: { cid: string; channelId: string; state: CommunityState }) {
  const client = useConcord();
  const messages = (use$(() => client.getMessages$(cid, channelId), [cid, channelId]) ?? []) as ChatMessage[];
  const typing = (use$(() => client.getTyping$(cid, channelId), [cid, channelId]) ?? []) as string[];
  const channel = state.channels.find((c) => c.channel_id === channelId);
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<{ id: string; author: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastTyping = useRef(0);

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

  function onInput(v: string) {
    setText(v);
    const now = Date.now();
    if (now - lastTyping.current > 3000 && v) {
      lastTyping.current = now;
      void client.sendTyping(cid, channelId);
    }
  }

  async function saveEdit(id: string) {
    const value = editText.trim();
    setEditing(null);
    if (value) await client.editMessage(cid, channelId, id, value);
  }

  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  return (
    <div className="main">
      <div className="main-header">
        <span className="hash" style={{ fontSize: 20, color: "var(--text-muted)" }}>
          {channel?.private ? "🔒" : "#"}
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
              <div className="big">👋</div>
              <div>This is the beginning of #{channel?.name}. Say hello!</div>
            </div>
          )}
          {messages.map((m) => (
            <div className="msg" key={m.id}>
              <div className="avatar" style={{ background: colorFor(m.author) }}>
                {initials(m.author)}
              </div>
              <div className="msg-body">
                {m.replyTo && (
                  <div className="msg-reply">
                    ↩ {displayName(m.replyTo.author)}: {byId.get(m.replyTo.id)?.content ?? "message"}
                  </div>
                )}
                <div className="msg-head">
                  <span className="name" style={{ color: colorFor(m.author) }}>
                    {displayName(m.author)}
                  </span>
                  <span className="time">{formatTime(m.ms)}</span>
                  {m.author === state.material.owner && <span className="badge owner">Owner</span>}
                </div>
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
                    ↩
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
                        ✎
                      </button>
                      <button title="Delete" onClick={() => client.deleteMessage(cid, channelId, m.id)}>
                        🗑
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      {canWrite && (
        <div className="composer">
          {replyTo && (
            <div className="reply-bar">
              <span>Replying to {displayName(replyTo.author)}</span>
              <button onClick={() => setReplyTo(null)}>✕</button>
            </div>
          )}
          <div className="box">
            <textarea
              rows={1}
              placeholder={`Message ${channel?.private ? "🔒" : "#"}${channel?.name ?? ""}`}
              value={text}
              onChange={(e) => onInput(e.target.value)}
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
          <div className="typing">
            {typing.length > 0 && (
              <span>
                <b>{typing.map(displayName).join(", ")}</b> {typing.length === 1 ? "is" : "are"} typing…
              </span>
            )}
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
      <div className="avatar" style={{ background: colorFor(m) }}>
        {initials(m)}
      </div>
      <span className="m-name">{displayName(m)}</span>
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
