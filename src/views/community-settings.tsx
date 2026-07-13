import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { DoorOpen, Hash, ImagePlus, Landmark, Lock, RefreshCw, Shield, Trash2, Users } from "lucide-react";
import { useNavigate } from "react-router";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useConcord } from "../lib/concord-context";
import { useCommunity } from "../hooks/use-community";
import { deleteCommunityRumorCache } from "../lib/rumor-cache";
import { UserAvatar, UserName } from "../components/User";
import { useDecryptedImage } from "../hooks/useDecryptedImage";
import { PERM } from "applesauce-concord";
import type { BlobPointer, CommunityState, PermName } from "applesauce-concord";
import { hasPerm, parsePermissions, resolveStanding } from "applesauce-concord/helpers";
import { ConfirmModal } from "../components/modals";
import { channelRoleId, channelRoster } from "../chat/channel-roles";

type PageId = "overview" | "roles" | "members" | "channels" | "advanced";

const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "overview", label: "Overview", icon: <Landmark size={18} /> },
  { id: "roles", label: "Roles", icon: <Shield size={18} /> },
  { id: "members", label: "Members", icon: <Users size={18} /> },
  { id: "channels", label: "Channels", icon: <Hash size={18} /> },
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
  const account = useActiveAccount();
  const state = use$(() => client.getState$(cid), [cid]) as CommunityState;
  // Fall back to the overview page for an unknown/empty page value.
  const page: PageId = PAGES.some((p) => p.id === pageParam) ? (pageParam as PageId) : "overview";

  if (!state) return null;
  const name = state.metadata?.name ?? state.material.name;
  const isOwner = account?.pubkey === state.material.owner;

  return (
    <div className="flex-1 flex min-w-0 bg-base-100 max-md:flex-col">
      <nav className="w-58 shrink-0 bg-base-200 px-2.5 py-4 overflow-y-auto flex flex-col gap-0.5 max-md:w-full max-md:flex-row max-md:items-center max-md:gap-1 max-md:py-2 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-base-300 max-md:pl-14">
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-3 text-[11px] uppercase font-bold tracking-wide opacity-60 max-md:p-0 max-md:pr-1 max-md:shrink-0">
          <CommunityIcon state={state} />
          <span className="max-md:hidden">{name}</span>
        </div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`btn btn-ghost btn-sm justify-start gap-2.5 w-full font-medium max-md:w-auto max-md:shrink-0 ${page === p.id ? "btn-active" : ""}`}
            onClick={() => onSelectPage(p.id)}
          >
            {p.icon}
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="flex-1 relative overflow-y-auto p-10 max-md:px-4 max-md:py-6">
        <div className="max-w-[640px]">
          {page === "overview" && <OverviewPage cid={cid} state={state} isOwner={isOwner} onClose={onClose} />}
          {page === "roles" && <RolesPage cid={cid} state={state} />}
          {page === "members" && <MembersPage cid={cid} state={state} />}
          {page === "channels" && <ChannelsPage cid={cid} state={state} />}
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
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg overflow-hidden bg-base-300 font-semibold text-base-content shrink-0 text-[11px]">
      {iconUrl ? <img className="w-full h-full object-cover" src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}

// ---- Overview (metadata + images + dissolve) -----------------------------

function OverviewPage({ cid, state, isOwner, onClose }: { cid: string; state: CommunityState; isOwner: boolean; onClose: () => void }) {
  const client = useConcord();
  const community = useCommunity(cid);
  const navigate = useNavigate();
  const [name, setName] = useState(state.metadata?.name ?? state.material.name);
  const [description, setDescription] = useState(state.metadata?.description ?? "");
  const [blossom, setBlossom] = useState((state.metadata?.blossom_servers ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const canManageMetadata = community?.canDo(PERM.MANAGE_METADATA) ?? false;

  // Leaving is available to every member (no permission needed) — tombstone the
  // membership, purge the community's decrypted rumor caches, then leave settings.
  async function leave() {
    await client.leave(cid);
    await deleteCommunityRumorCache(cid);
    onClose();
    navigate("/");
  }

  async function save() {
    setBusy(true);
    setSaved(false);
    const blossom_servers = blossom
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    await community?.editMetadata({ name: name.trim(), description: description.trim(), blossom_servers });
    setBusy(false);
    setSaved(true);
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Overview</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">The community's name, description, and images. Members see these everywhere.</p>
      {canManageMetadata && (
        <div className="mb-4">
          <label className="label text-xs font-semibold uppercase opacity-70">Images</label>
          <div className="flex gap-5 items-start">
            <ImageField cid={cid} which="icon" pointer={state.metadata?.icon} disabled={state.dissolved} />
            <ImageField cid={cid} which="banner" pointer={state.metadata?.banner} disabled={state.dissolved} />
          </div>
        </div>
      )}
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Name</label>
        <input className="input input-bordered w-full" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={64} />
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Description</label>
        <textarea className="textarea textarea-bordered w-full" value={description} onChange={(e) => { setDescription(e.target.value); setSaved(false); }} rows={3} />
      </div>
      {canManageMetadata && (
        <div className="mb-4">
          <label className="label text-xs font-semibold uppercase opacity-70">Blossom media servers</label>
          <textarea
            className="textarea textarea-bordered w-full"
            value={blossom}
            onChange={(e) => { setBlossom(e.target.value); setSaved(false); }}
            rows={2}
            placeholder={"https://blossom.example/\n(one per line — leave empty to use your own)"}
          />
        </div>
      )}
      <div className="flex items-center gap-3.5 mt-5">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-success text-sm font-semibold">Saved ✓</span>}
      </div>

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Danger zone</h3>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Community ID</label>
        <div className="rounded-box bg-base-200 border border-base-300 p-3 font-mono text-xs break-all opacity-70">{state.material.community_id}</div>
      </div>
      <div className="flex flex-wrap gap-3">
        <button className="btn btn-error btn-outline gap-2" onClick={() => setLeaveOpen(true)}>
          <DoorOpen size={18} />
          Leave community
        </button>
        {isOwner && (
          <button
            className="btn btn-error"
            onClick={async () => {
              if (confirm("Dissolve this community permanently? This cannot be undone.")) {
                await community?.dissolve();
                onClose();
              }
            }}
          >
            Dissolve community
          </button>
        )}
      </div>

      {leaveOpen && (
        <ConfirmModal
          title={`Leave ${name}?`}
          danger
          confirmLabel="Leave community"
          onClose={() => setLeaveOpen(false)}
          onConfirm={leave}
          body={
            <p>
              You'll be removed from <strong>{name}</strong> and it will disappear from your list. You
              can rejoin later with an invite link.
            </p>
          }
        />
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
  const community = useCommunity(cid);
  const url = useDecryptedImage(pointer);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      await community?.setCommunityImage(which, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const previewSize = which === "icon" ? "w-16 h-16 rounded-xl" : "w-40 h-16 rounded-lg";
  return (
    <div className={`flex flex-col gap-1.5 ${which === "banner" ? "flex-1" : ""}`}>
      <span className="text-xs opacity-60">{which === "icon" ? "Icon" : "Banner"}</span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`flex items-center justify-center overflow-hidden border border-dashed border-base-300 bg-base-200 text-base-content/60 cursor-pointer hover:border-primary hover:text-base-content disabled:opacity-60 disabled:cursor-default ${previewSize}`}
          disabled={disabled || busy}
          onClick={() => inputRef.current?.click()}
          title={url ? "Replace" : "Upload"}
        >
          {url ? <img className="w-full h-full object-cover" src={url} alt="" /> : busy ? <span className="loading loading-spinner loading-sm" /> : <ImagePlus size={20} />}
        </button>
        {pointer && !busy && (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-square"
            title={`Remove ${which}`}
            disabled={disabled}
            onClick={() => community?.removeCommunityImage(which)}
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
      {busy && <span className="text-xs opacity-60">Encrypting & uploading…</span>}
      {error && <span className="text-error text-xs">{error}</span>}
    </div>
  );
}

// ---- Roles ---------------------------------------------------------------

function RolesPage({ cid, state }: { cid: string; state: CommunityState }) {
  const community = useCommunity(cid);
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
    await community?.createRole(name.trim(), position, bits);
    setName("");
    setPerms(new Set());
    setBusy(false);
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Roles</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">Roles bundle permissions you can grant to members. The owner is always supreme.</p>
      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Existing roles</h3>
      {state.roles.length === 0 && <p className="text-sm opacity-70 leading-relaxed mb-5">No roles yet.</p>}
      {state.roles.map((r) => (
        <div key={r.role_id} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200">
          <span className="badge badge-primary badge-sm" style={{ background: r.color ? `#${r.color.toString(16)}` : undefined }}>
            {r.name}
          </span>
          <span className="text-xs opacity-60">pos {r.position}</span>
          <span className="ml-auto">
            {(Object.keys(PERM) as PermName[])
              .filter((p) => (parsePermissions(r.permissions) & PERM[p]) === PERM[p])
              .map((p) => (
                <span key={p} className="badge badge-ghost badge-sm m-0.5">
                  {PERM_LABELS[p]}
                </span>
              ))}
          </span>
        </div>
      ))}

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Create role</h3>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Role name</label>
        <input className="input input-bordered w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Moderator" maxLength={64} />
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Permissions</label>
        {(Object.keys(PERM) as PermName[]).map((p) => (
          <div key={p} className="flex items-center gap-2.5 py-1">
            <input type="checkbox" className="checkbox checkbox-sm" id={p} checked={perms.has(p)} onChange={() => toggle(p)} />
            <label htmlFor={p} className="cursor-pointer text-sm">
              {PERM_LABELS[p]}
            </label>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3.5 mt-5">
        <button className="btn btn-primary" onClick={create} disabled={!name.trim() || busy}>
          Create role
        </button>
      </div>
    </>
  );
}

// ---- Members -------------------------------------------------------------

function MembersPage({ cid, state }: { cid: string; state: CommunityState }) {
  const account = useActiveAccount();
  const community = useCommunity(cid);
  const members = [...state.members];
  const rolesMap = new Map(state.roles.map((r) => [r.role_id, r]));
  // The CALLER's standing governs which admin actions are offered, not the
  // viewed member's. resolveStanding returns isOwner + folded permissions.
  const caller = resolveStanding(account?.pubkey ?? "", state.material.owner, rolesMap, state.grants);
  const canBan = caller.isOwner || hasPerm(caller.permissions, PERM.BAN);
  const canKick = caller.isOwner || hasPerm(caller.permissions, PERM.KICK);
  const [banTarget, setBanTarget] = useState<string | null>(null);

  const doBan = async (member: string) => {
    // 1. Soft ban: banlist + strip roles (CORD-04).
    await community?.ban(member);
    // 2. Hard enforcement: Refound to sever the banned member's keys from
    //    the control plane and every channel (CORD-06 §3). keep = everyone
    //    still in the community except the banned member.
    const keep = members.filter((m) => m !== member);
    await community?.refound({ keep, exclude: [member] });
  };

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Members</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">Everyone in the community. Assign roles, or kick and ban members.</p>
      {members.map((m) => {
        const standing = resolveStanding(m, state.material.owner, rolesMap, state.grants);
        const held = new Set(state.grants.get(m) ?? []);
        const banned = state.banlist.has(m);
        return (
          <div key={m} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200 flex-wrap">
            <UserAvatar pubkey={m} />
            <div>
              <div className="font-medium">
                <UserName pubkey={m} />
              </div>
              {standing.isOwner && <span className="badge badge-warning badge-sm">Owner</span>}
            </div>
            <div className="ml-auto flex gap-1.5">
              {!standing.isOwner && (canKick || canBan) && (
                <>
                  {canKick && (
                    <button className="btn btn-ghost btn-sm" onClick={() => community?.kick(m)}>
                      Kick
                    </button>
                  )}
                  {banned ? (
                    canBan && (
                      <button className="btn btn-ghost btn-sm" onClick={() => community?.unban(m)}>
                        Unban
                      </button>
                    )
                  ) : (
                    canBan && (
                      <button
                        className="btn btn-error btn-sm"
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
              <div className="w-full flex gap-1.5 flex-wrap pl-[42px]">
                {state.roles.map((r) => {
                  const on = held.has(r.role_id);
                  return (
                    <button
                      key={r.role_id}
                      className={`badge badge-sm cursor-pointer ${on ? "badge-primary" : "badge-ghost"}`}
                      onClick={() => {
                        const next = new Set(held);
                        if (on) next.delete(r.role_id);
                        else next.add(r.role_id);
                        community?.grantRoles(m, [...next]);
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
      {members.length === 0 && <p className="text-sm opacity-70 leading-relaxed mb-5">No members yet.</p>}
      {state.banlist.size > 0 && (
        <>
          <h2 className="text-2xl font-bold mb-1 mt-6">Banned members</h2>
          <p className="text-sm opacity-70 leading-relaxed mb-5">
            Banned members can't rejoin. Unban removes them from the banlist; to let them back in,
            mint a fresh invite from the sidebar (the link carries current keys, so they rejoin
            without access to history from before the refounding).
          </p>
          {[...state.banlist].sort().map((m) => (
            <div key={m} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200">
              <UserAvatar pubkey={m} />
              <div>
                <div className="font-medium">
                  <UserName pubkey={m} />
                </div>
                <span className="badge badge-error badge-sm">
                  Banned
                </span>
              </div>
              <div className="ml-auto">
                {canBan && (
                  <button className="btn btn-ghost btn-sm" onClick={() => community?.unban(m)}>
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
              <p className="text-sm opacity-70 leading-relaxed">
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

// ---- Channels (private-channel membership) -------------------------------

function ChannelsPage({ cid, state }: { cid: string; state: CommunityState }) {
  const community = useCommunity(cid);
  const canManage = community?.canDo(PERM.MANAGE_CHANNELS) ?? false;
  const owner = state.material.owner;
  const privateChannels = state.channels.filter((c) => c.private && !c.deleted);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [kickTarget, setKickTarget] = useState<{ channelId: string; member: string; name: string } | null>(null);

  async function addMember(channelId: string, member: string) {
    if (!community) return;
    setBusy(true);
    setError("");
    try {
      // Grant the channel-scoped role first (the observable roster), then deliver
      // the current channel key — CORD-03 "delivered on grant", no rotation.
      const rid = channelRoleId(channelId, state);
      if (rid) {
        const grants = new Set(state.grants.get(member) ?? []);
        grants.add(rid);
        await community.grantRoles(member, [...grants]);
      }
      await community.grantChannelAccess(channelId, member);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function kickMember(channelId: string, member: string) {
    if (!community) return;
    // Remove them from the roster, then rekey the channel excluding them — the
    // only removal that enforces (CORD-06). rotateChannel requires we outrank them.
    const rid = channelRoleId(channelId, state);
    if (rid) {
      const grants = new Set(state.grants.get(member) ?? []);
      grants.delete(rid);
      await community.grantRoles(member, [...grants]);
    }
    const keep = channelRoster(channelId, state).filter((m) => m !== member);
    await community.rotateChannel(channelId, { keep, exclude: [member] });
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Channels</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Private channels and who can read them. Adding a member hands over the channel key; removing
        one rotates the key so they lose access to everything sent afterward.
      </p>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      {privateChannels.length === 0 && (
        <p className="text-sm opacity-70 leading-relaxed mb-5">
          No private channels yet. Create one from the sidebar (check “Private channel”).
        </p>
      )}
      {privateChannels.map((ch) => {
        const roster = channelRoster(ch.channel_id, state);
        const rosterSet = new Set(roster);
        const outsiders = [...state.members].filter((m) => !rosterSet.has(m)).sort();
        return (
          <div key={ch.channel_id} className="mb-7">
            <div className="flex items-center gap-2 mb-2">
              <Lock size={16} />
              <strong>{ch.name}</strong>
              <span className="text-sm opacity-70">
                {roster.length} member{roster.length === 1 ? "" : "s"}
              </span>
              {canManage && (
                <button
                  className="btn btn-error btn-sm ml-auto"
                  onClick={() => setDeleteTarget({ id: ch.channel_id, name: ch.name })}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
            {roster.map((m) => (
              <div key={m} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200">
                <UserAvatar pubkey={m} />
                <div>
                  <div className="font-medium">
                    <UserName pubkey={m} />
                  </div>
                  {m === owner && <span className="badge badge-warning badge-sm">Owner</span>}
                </div>
                {canManage && m !== owner && (
                  <div className="ml-auto">
                    <button
                      className="btn btn-ghost btn-sm"
                      disabled={busy}
                      onClick={() => setKickTarget({ channelId: ch.channel_id, member: m, name: ch.name })}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
            {canManage && outsiders.length > 0 && (
              <div className="mt-2">
                <select
                  className="select select-bordered w-full"
                  value=""
                  disabled={busy}
                  onChange={(e) => {
                    if (e.target.value) void addMember(ch.channel_id, e.target.value);
                  }}
                >
                  <option value="">Add a member…</option>
                  {outsiders.map((m) => (
                    <option key={m} value={m}>
                      {m.slice(0, 12)}…
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        );
      })}
      {deleteTarget && (
        <ConfirmModal
          title={`Delete #${deleteTarget.name}`}
          danger
          confirmLabel="Delete channel"
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            await community?.deleteChannel(deleteTarget.id);
          }}
          body={
            <p>
              Delete <strong>#{deleteTarget.name}</strong> for everyone. Its message history stops
              syncing and the channel disappears from the sidebar. This cannot be undone.
            </p>
          }
        />
      )}
      {kickTarget && (
        <ConfirmModal
          title="Remove from channel"
          danger
          confirmLabel="Remove & rekey"
          onClose={() => setKickTarget(null)}
          onConfirm={async () => {
            await kickMember(kickTarget.channelId, kickTarget.member);
          }}
          body={
            <p>
              Remove <UserName pubkey={kickTarget.member} /> from <strong>#{kickTarget.name}</strong> and
              rotate its key. They keep whatever they already synced, but nothing sent afterward will
              decrypt for them. Remaining members re-sync automatically.
            </p>
          }
        />
      )}
    </>
  );
}

// ---- Advanced (testing/debug actions) ------------------------------------

function AdvancedPage({ cid, state }: { cid: string; state: CommunityState }) {
  const account = useActiveAccount();
  const community = useCommunity(cid);
  const rolesMap = new Map(state.roles.map((r) => [r.role_id, r]));
  const caller = resolveStanding(account?.pubkey ?? "", state.material.owner, rolesMap, state.grants);
  const canRekey = caller.isOwner || hasPerm(caller.permissions, PERM.BAN);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function doRekey() {
    setError(null);
    setBusy(true);
    try {
      // A community-wide epoch rotation is a no-exclude Refounding (CORD-06):
      // keep every current member, remove no one.
      await community?.refound({ keep: [...state.members] });
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
      <h2 className="text-2xl font-bold mb-1">Advanced</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">Testing and maintenance actions. These are safe but disruptive.</p>

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Danger zone</h3>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Rotate epoch (Rekey)</label>
        <p className="text-sm opacity-70 leading-relaxed mb-5">
          Forces a community-wide epoch rotation (a no-exclude Refounding, CORD-06). Rolls
          <code> community_root</code> forward, re-keys every channel and voice room, and
          triggers a brief re-sync for other members. No one is removed — useful for
          testing the rotation path.
        </p>
        {canRekey ? (
          <button className="btn btn-error" disabled={busy} onClick={() => setConfirm(true)}>
            {busy ? "Rotating…" : "Rotate epoch"}
          </button>
        ) : (
          <p className="text-sm opacity-70 leading-relaxed mb-5">Requires ownership or the Ban Members permission.</p>
        )}
        {done && <span className="text-success text-sm font-semibold">Rotated ✓</span>}
        {error && <span className="text-error text-xs">{error}</span>}
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
              <p className="text-sm opacity-70 leading-relaxed">
                No members are removed. This cannot be quietly undone.
              </p>
            </>
          }
        />
      )}
    </>
  );
}
