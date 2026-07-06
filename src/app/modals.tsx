import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import { useConcord } from "./context";
import { displayName, colorFor, initials } from "./util";
import { PERM } from "../concord/types";
import type { CommunityState, PermName } from "../concord/types";
import { parsePermissions, resolveStanding } from "../concord/permissions";

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function CreateCommunityModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [relays, setRelays] = useState("wss://relay.damus.io\nwss://nos.lol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const relayList = relays.split("\n").map((r) => r.trim()).filter(Boolean);
      const id = await client.createNewCommunity(name.trim(), description.trim(), relayList);
      onCreated(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Create a community</h2>
      <p className="sub">Your community, your rules. It's yours forever — you're the owner.</p>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label>Community name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="My Community" maxLength={64} autoFocus />
      </div>
      <div className="field">
        <label>Description (optional)</label>
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's it about?" />
      </div>
      <div className="field">
        <label>Relays (one per line)</label>
        <textarea value={relays} onChange={(e) => setRelays(e.target.value)} rows={3} />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={create} disabled={!name.trim() || busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

export function JoinModal({ onClose, onJoined }: { onClose: () => void; onJoined: (id: string) => void }) {
  const client = useConcord();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function join() {
    setBusy(true);
    setError("");
    try {
      const id = await client.joinByLink(link.trim());
      onJoined(id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Join a community</h2>
      <p className="sub">Paste an invite link. Only people with the link can join.</p>
      {error && <div className="error">{error}</div>}
      <div className="field">
        <label>Invite link</label>
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://…/invite/naddr…#…"
          autoFocus
        />
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={join} disabled={!link.trim() || busy}>
          {busy ? "Joining…" : "Join"}
        </button>
      </div>
    </Modal>
  );
}

export function CreateChannelModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    setBusy(true);
    try {
      await client.createChannel(cid, name.trim().toLowerCase().replace(/\s+/g, "-"), priv);
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2>Create channel</h2>
      <div className="field">
        <label>Channel name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="new-channel" autoFocus maxLength={64} />
      </div>
      <div className="check-row">
        <input type="checkbox" id="priv" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
        <label htmlFor="priv" style={{ margin: 0 }}>
          Private channel (its own key, only role-holders can read)
        </label>
      </div>
      <div className="modal-actions">
        <button className="btn secondary" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={create} disabled={!name.trim() || busy}>
          Create
        </button>
      </div>
    </Modal>
  );
}

export function InviteModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // mint one link per modal open (StrictMode-safe)
    started.current = true;
    (async () => {
      try {
        const base = window.location.origin;
        setLink(await client.createInvite(cid, base));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [cid, client]);

  return (
    <Modal onClose={onClose}>
      <h2>Invite people</h2>
      <p className="sub">Anyone with this link can join. The link carries no keys — those live encrypted on relays.</p>
      {error && <div className="error">{error}</div>}
      {busy ? (
        <p>Minting invite…</p>
      ) : (
        <>
          <div className="invite-link">{link}</div>
          <button className="btn full" onClick={() => navigator.clipboard.writeText(link)}>
            Copy link
          </button>
        </>
      )}
    </Modal>
  );
}

const PERM_LABELS: Record<PermName, string> = {
  MANAGE_ROLES: "Manage Roles",
  MANAGE_CHANNELS: "Manage Channels",
  MANAGE_METADATA: "Manage Community",
  KICK: "Kick Members",
  BAN: "Ban Members",
  MANAGE_MESSAGES: "Manage Messages",
  CREATE_INVITE: "Create Invites",
  VIEW_AUDIT_LOG: "View Audit Log",
  MENTION_EVERYONE: "Mention Everyone",
};

export function AdminModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const state = use$(() => client.getState$(cid), [cid]) as CommunityState;
  const [tab, setTab] = useState<"overview" | "roles" | "members">("overview");

  if (!state) return null;
  const isOwner = client.pubkey === state.material.owner;

  return (
    <Modal onClose={onClose}>
      <h2>Community settings</h2>
      <div className="tabs">
        <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>
          Overview
        </button>
        <button className={tab === "roles" ? "active" : ""} onClick={() => setTab("roles")}>
          Roles
        </button>
        <button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}>
          Members
        </button>
      </div>
      {tab === "overview" && <OverviewTab cid={cid} state={state} isOwner={isOwner} onClose={onClose} />}
      {tab === "roles" && <RolesTab cid={cid} state={state} />}
      {tab === "members" && <MembersTab cid={cid} state={state} />}
    </Modal>
  );
}

function OverviewTab({ cid, state, isOwner, onClose }: { cid: string; state: CommunityState; isOwner: boolean; onClose: () => void }) {
  const client = useConcord();
  const [name, setName] = useState(state.metadata?.name ?? state.material.name);
  const [description, setDescription] = useState(state.metadata?.description ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    await client.editMetadata(cid, { name: name.trim(), description: description.trim() });
    setBusy(false);
  }

  return (
    <>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
      </div>
      <button className="btn" onClick={save} disabled={busy}>
        Save changes
      </button>
      <div style={{ marginTop: 24, borderTop: "1px solid var(--border)", paddingTop: 16 }}>
        <div className="field">
          <label>Community ID</label>
          <div className="invite-link">{state.material.community_id}</div>
        </div>
        {isOwner && (
          <button
            className="btn danger"
            onClick={async () => {
              if (confirm("Dissolve this community permanently? This cannot be undone.")) {
                await client.dissolve(cid);
                onClose();
              }
            }}
          >
            Dissolve community
          </button>
        )}
      </div>
    </>
  );
}

function RolesTab({ cid, state }: { cid: string; state: CommunityState }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<Set<PermName>>(new Set());
  const [busy, setBusy] = useState(false);

  function toggle(p: PermName) {
    const next = new Set(perms);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPerms(next);
  }

  async function create() {
    setBusy(true);
    let bits = 0n;
    for (const p of perms) bits |= PERM[p];
    const position = state.roles.length + 1;
    await client.createRole(cid, name.trim(), position, bits);
    setName("");
    setPerms(new Set());
    setBusy(false);
  }

  return (
    <>
      <h3 style={{ color: "var(--text-bright)" }}>Existing roles</h3>
      {state.roles.length === 0 && <p className="sub">No roles yet. The owner is always supreme.</p>}
      {state.roles.map((r) => (
        <div key={r.role_id} className="role-row">
          <span className="badge role" style={{ background: r.color ? `#${r.color.toString(16)}` : undefined }}>
            {r.name}
          </span>
          <span className="sub" style={{ fontSize: 12, color: "var(--text-muted)" }}>pos {r.position}</span>
          <span style={{ marginLeft: "auto" }}>
            {(Object.keys(PERM) as PermName[])
              .filter((p) => (parsePermissions(r.permissions) & PERM[p]) === PERM[p])
              .map((p) => (
                <span key={p} className="pill">
                  {PERM_LABELS[p]}
                </span>
              ))}
          </span>
        </div>
      ))}

      <h3 style={{ color: "var(--text-bright)", marginTop: 20 }}>Create role</h3>
      <div className="field">
        <label>Role name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Moderator" maxLength={64} />
      </div>
      <div className="field">
        <label>Permissions</label>
        {(Object.keys(PERM) as PermName[]).map((p) => (
          <div key={p} className="check-row">
            <input type="checkbox" id={p} checked={perms.has(p)} onChange={() => toggle(p)} />
            <label htmlFor={p} style={{ margin: 0 }}>
              {PERM_LABELS[p]}
            </label>
          </div>
        ))}
      </div>
      <button className="btn" onClick={create} disabled={!name.trim() || busy}>
        Create role
      </button>
    </>
  );
}

function MembersTab({ cid, state }: { cid: string; state: CommunityState }) {
  const client = useConcord();
  const members = [...state.members];
  const rolesMap = new Map(state.roles.map((r) => [r.role_id, r]));

  return (
    <>
      {members.map((m) => {
        const standing = resolveStanding(m, state.material.owner, rolesMap, state.grants);
        const held = new Set(state.grants.get(m) ?? []);
        const banned = state.banlist.has(m);
        return (
          <div key={m} className="role-row" style={{ flexWrap: "wrap" }}>
            <div className="avatar" style={{ background: colorFor(m) }}>
              {initials(m)}
            </div>
            <div>
              <div className="m-name">{displayName(m)}</div>
              {standing.isOwner && <span className="badge owner">Owner</span>}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {!standing.isOwner && (
                <>
                  <button className="btn ghost" onClick={() => client.kick(cid, m)}>
                    Kick
                  </button>
                  {banned ? (
                    <button className="btn ghost" onClick={() => client.unban(cid, m)}>
                      Unban
                    </button>
                  ) : (
                    <button className="btn danger" onClick={() => client.ban(cid, m)}>
                      Ban
                    </button>
                  )}
                </>
              )}
            </div>
            {!standing.isOwner && state.roles.length > 0 && (
              <div style={{ width: "100%", display: "flex", gap: 6, flexWrap: "wrap", paddingLeft: 42 }}>
                {state.roles.map((r) => {
                  const on = held.has(r.role_id);
                  return (
                    <button
                      key={r.role_id}
                      className="pill"
                      style={on ? { background: "var(--accent)", color: "white" } : {}}
                      onClick={() => {
                        const next = new Set(held);
                        if (on) next.delete(r.role_id);
                        else next.add(r.role_id);
                        client.grantRoles(cid, m, [...next]);
                      }}
                    >
                      {r.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
