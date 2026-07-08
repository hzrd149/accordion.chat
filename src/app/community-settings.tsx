import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ImagePlus, Landmark, RefreshCw, Shield, Trash2, Users, X } from "lucide-react";
import { use$ } from "applesauce-react/hooks";
import { useConcord } from "./concord-context";
import { UserAvatar, UserName } from "./User";
import { useDecryptedImage } from "./useDecryptedImage";
import { PERM } from "../concord/types";
import type { BlobPointer, CommunityState, PermName } from "../concord/types";
import { hasPerm, parsePermissions, resolveStanding } from "../concord/permissions";
import { ConfirmModal } from "./modals";

type PageId = "overview" | "roles" | "members" | "advanced";

const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <Landmark size={18} /> },
  { id: "roles", label: "Roles", icon: <Shield size={18} /> },
  { id: "members", label: "Members", icon: <Users size={18} /> },
  { id: "advanced", label: "Advanced", icon: <RefreshCw size={18} /> },
];

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

/** Full-page community settings, with a sub-page per admin area. */
export function CommunitySettingsView({
  cid,
  page: pageParam,
  onSelectPage,
  onClose,
}: {
  cid: string;
  page: string;
  onSelectPage: (page: PageId) => void;
  onClose: () => void;
}) {
  const client = useConcord();
  const state = use$(() => client.getState$(cid), [cid]) as CommunityState;
  // Fall back to the overview page for an unknown/empty `?admin=` value.
  const page: PageId = PAGES.some((p) => p.id === pageParam) ? (pageParam as PageId) : "overview";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!state) return null;
  const name = state.metadata?.name ?? state.material.name;
  const isOwner = client.pubkey === state.material.owner;

  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-head">
          <CommunityIcon state={state} />
          <span>{name}</span>
        </div>
        {PAGES.map((p) => (
          <button key={p.id} className={`settings-nav-item ${page === p.id ? "active" : ""}`} onClick={() => onSelectPage(p.id)}>
            {p.icon}
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <button className="settings-close" title="Close (Esc)" onClick={onClose}>
          <X size={22} />
        </button>
        <div className="settings-page">
          {page === "overview" && <OverviewPage cid={cid} state={state} isOwner={isOwner} onClose={onClose} />}
          {page === "roles" && <RolesPage cid={cid} state={state} />}
          {page === "members" && <MembersPage cid={cid} state={state} />}
          {page === "advanced" && <AdvancedPage cid={cid} state={state} />}
        </div>
      </div>
    </div>
  );
}

function CommunityIcon({ state }: { state: CommunityState }) {
  const name = state.metadata?.name ?? state.material.name;
  const iconUrl = useDecryptedImage(state.metadata?.icon);
  return (
    <span className={`rail-icon${iconUrl ? " has-image" : ""}`} style={{ width: 28, height: 28, fontSize: 11 }}>
      {iconUrl ? <img src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}

// ---- Overview (metadata + images + dissolve) -----------------------------

function OverviewPage({ cid, state, isOwner, onClose }: { cid: string; state: CommunityState; isOwner: boolean; onClose: () => void }) {
  const client = useConcord();
  const [name, setName] = useState(state.metadata?.name ?? state.material.name);
  const [description, setDescription] = useState(state.metadata?.description ?? "");
  const [blossom, setBlossom] = useState((state.metadata?.blossom_servers ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const canManageMetadata = client.canDo(cid, PERM.MANAGE_METADATA);

  async function save() {
    setBusy(true);
    setSaved(false);
    const blossom_servers = blossom
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    await client.editMetadata(cid, { name: name.trim(), description: description.trim(), blossom_servers });
    setBusy(false);
    setSaved(true);
  }

  return (
    <>
      <h2>Overview</h2>
      <p className="settings-sub">The community's name, description, and images. Members see these everywhere.</p>
      {canManageMetadata && (
        <div className="field">
          <label>Images</label>
          <div className="image-fields">
            <ImageField cid={cid} which="icon" pointer={state.metadata?.icon} disabled={state.dissolved} />
            <ImageField cid={cid} which="banner" pointer={state.metadata?.banner} disabled={state.dissolved} />
          </div>
        </div>
      )}
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={64} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} rows={3} />
      </div>
      {canManageMetadata && (
        <div className="field">
          <label>Blossom media servers</label>
          <textarea
            value={blossom}
            onChange={(e) => { setBlossom(e.target.value); setSaved(false); }}
            rows={2}
            placeholder={"https://blossom.example/\n(one per line — leave empty to use your own)"}
          />
        </div>
      )}
      <div className="settings-actions">
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="settings-saved">Saved ✓</span>}
      </div>

      <h3>Danger zone</h3>
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
    </>
  );
}

function ImageField({
  cid,
  which,
  pointer,
  disabled,
}: {
  cid: string;
  which: "icon" | "banner";
  pointer: BlobPointer | undefined;
  disabled: boolean;
}) {
  const client = useConcord();
  const url = useDecryptedImage(pointer);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      await client.setCommunityImage(cid, which, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`image-field ${which}`}>
      <span className="image-field-label">{which === "icon" ? "Icon" : "Banner"}</span>
      <div className="image-field-controls">
        <button
          type="button"
          className={`image-preview ${which}`}
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
          title={url ? "Replace" : "Upload"}
        >
          {url ? <img src={url} alt="" /> : busy ? <span className="spin-dot" /> : <ImagePlus size={20} />}
        </button>
        {pointer && !busy && (
          <button
            type="button"
            className="icon-btn"
            title={`Remove ${which}`}
            disabled={disabled}
            onClick={() => client.removeCommunityImage(cid, which)}
          >
            <Trash2 size={16} />
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) onFile(file);
        }}
      />
      {busy && <span className="sub">Encrypting & uploading…</span>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}

// ---- Roles ---------------------------------------------------------------

function RolesPage({ cid, state }: { cid: string; state: CommunityState }) {
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
      <h2>Roles</h2>
      <p className="settings-sub">Roles bundle permissions you can grant to members. The owner is always supreme.</p>
      <h3>Existing roles</h3>
      {state.roles.length === 0 && <p className="settings-sub">No roles yet.</p>}
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

      <h3>Create role</h3>
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
      <div className="settings-actions">
        <button className="btn" onClick={create} disabled={!name.trim() || busy}>
          Create role
        </button>
      </div>
    </>
  );
}

// ---- Members -------------------------------------------------------------

function MembersPage({ cid, state }: { cid: string; state: CommunityState }) {
  const client = useConcord();
  const members = [...state.members];
  const rolesMap = new Map(state.roles.map((r) => [r.role_id, r]));
  // The CALLER's standing governs which admin actions are offered, not the
  // viewed member's. resolveStanding returns isOwner + folded permissions.
  const caller = resolveStanding(client.pubkey, state.material.owner, rolesMap, state.grants);
  const canBan = caller.isOwner || hasPerm(caller.permissions, PERM.BAN);
  const canKick = caller.isOwner || hasPerm(caller.permissions, PERM.KICK);
  const [banTarget, setBanTarget] = useState<string | null>(null);

  const doBan = async (member: string) => {
    // 1. Soft ban: banlist + strip roles (CORD-04).
    await client.ban(cid, member);
    // 2. Hard enforcement: Refound to sever the banned member's keys from
    //    the control plane and every channel (CORD-06 §3). keep = everyone
    //    still in the community except the banned member.
    const keep = members.filter((m) => m !== member);
    await client.refound(cid, { keep, exclude: [member] });
  };

  return (
    <>
      <h2>Members</h2>
      <p className="settings-sub">Everyone in the community. Assign roles, or kick and ban members.</p>
      {members.map((m) => {
        const standing = resolveStanding(m, state.material.owner, rolesMap, state.grants);
        const held = new Set(state.grants.get(m) ?? []);
        const banned = state.banlist.has(m);
        return (
          <div key={m} className="role-row" style={{ flexWrap: "wrap" }}>
            <UserAvatar pubkey={m} />
            <div>
              <div className="m-name">
                <UserName pubkey={m} />
              </div>
              {standing.isOwner && <span className="badge owner">Owner</span>}
            </div>
            <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
              {!standing.isOwner && (canKick || canBan) && (
                <>
                  {canKick && (
                    <button className="btn ghost" onClick={() => client.kick(cid, m)}>
                      Kick
                    </button>
                  )}
                  {banned ? (
                    canBan && (
                      <button className="btn ghost" onClick={() => client.unban(cid, m)}>
                        Unban
                      </button>
                    )
                  ) : (
                    canBan && (
                      <button
                        className="btn danger"
                        onClick={() => setBanTarget(m)}
                      >
                        Ban
                      </button>
                    )
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
      {members.length === 0 && <p className="settings-sub">No members yet.</p>}
      {state.banlist.size > 0 && (
        <>
          <h2 style={{ marginTop: 24 }}>Banned members</h2>
          <p className="settings-sub">
            Banned members can't rejoin. Unban removes them from the banlist; to let them back in,
            mint a fresh invite from the sidebar (the link carries current keys, so they rejoin
            without access to history from before the refounding).
          </p>
          {[...state.banlist].sort().map((m) => (
            <div key={m} className="role-row">
              <UserAvatar pubkey={m} />
              <div>
                <div className="m-name">
                  <UserName pubkey={m} />
                </div>
                <span className="badge" style={{ background: "rgba(248,113,113,0.15)", color: "#f87171" }}>
                  Banned
                </span>
              </div>
              <div style={{ marginLeft: "auto" }}>
                {canBan && (
                  <button className="btn ghost" onClick={() => client.unban(cid, m)}>
                    Unban
                  </button>
                )}
              </div>
            </div>
          ))}
        </>
      )}
      {banTarget && (
        <ConfirmModal
          title="Ban and refound"
          danger
          confirmLabel="Ban & sever keys"
          onClose={() => setBanTarget(null)}
          onConfirm={async () => {
            await doBan(banTarget);
          }}
          body={
            <>
              <p>
                Banning <UserName pubkey={banTarget} /> adds them to the banlist, strips their
                roles, and <strong>refounds the community</strong> to sever their keys from the
                control plane and every channel (CORD-06). All remaining members are re-keyed.
              </p>
              <p className="settings-sub">
                This rotates every channel key and voice room. Other members will see a brief
                re-sync. This cannot be quietly undone.
              </p>
            </>
          }
        />
      )}
    </>
  );
}

// ---- Advanced (testing/debug actions) ------------------------------------

function AdvancedPage({ cid, state }: { cid: string; state: CommunityState }) {
  const client = useConcord();
  const rolesMap = new Map(state.roles.map((r) => [r.role_id, r]));
  const caller = resolveStanding(client.pubkey, state.material.owner, rolesMap, state.grants);
  const canRekey = caller.isOwner || hasPerm(caller.permissions, PERM.BAN);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function doRekey() {
    setError(null);
    setBusy(true);
    try {
      await client.rekey(cid);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rekey failed");
    } finally {
      setBusy(false);
      setConfirm(false);
    }
  }

  return (
    <>
      <h2>Advanced</h2>
      <p className="settings-sub">Testing and maintenance actions. These are safe but disruptive.</p>

      <h3>Danger zone</h3>
      <div className="field">
        <label>Rotate epoch (Rekey)</label>
        <p className="settings-sub">
          Forces a community-wide epoch rotation (a no-exclude Refounding, CORD-06). Rolls
          <code> community_root</code> forward, re-keys every channel and voice room, and
          triggers a brief re-sync for other members. No one is removed — useful for
          testing the rotation path.
        </p>
        {canRekey ? (
          <button className="btn danger" disabled={busy} onClick={() => setConfirm(true)}>
            {busy ? "Rotating…" : "Rotate epoch"}
          </button>
        ) : (
          <p className="settings-sub">Requires ownership or the Ban Members permission.</p>
        )}
        {done && <span className="settings-saved">Rotated ✓</span>}
        {error && <span className="error-text">{error}</span>}
      </div>

      {confirm && (
        <ConfirmModal
          title="Rotate epoch"
          danger
          confirmLabel="Rotate epoch"
          onClose={() => setConfirm(false)}
          onConfirm={doRekey}
          body={
            <>
              <p>
                This rotates <strong>{state.metadata?.name ?? state.material.name}</strong> to
                the next epoch. Every channel key and voice room is re-keyed; other members
                will see a brief re-sync as they follow the rotation forward.
              </p>
              <p className="settings-sub">
                No members are removed. This cannot be quietly undone.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
