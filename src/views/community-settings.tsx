import { useRef, useState } from "react";
import type { ReactNode } from "react";
import { DoorOpen, Hash, ImagePlus, Landmark, Lock, RefreshCw, Shield, Trash2, Users } from "lucide-react";
import { useNavigate } from "react-router";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useConcord } from "../lib/concord-context";
import { useCommunity } from "../hooks/use-community";
import { useDevMode } from "../lib/dev-mode";
import { deleteCommunityRumorCache } from "../lib/rumor-cache";
import { clearCommunityReadState } from "../lib/read-state";
import { UserAvatar, UserName } from "../components/User";
import { useDecryptedImage } from "../hooks/useDecryptedImage";
import { useMentionCandidates, useMentionSearch } from "../hooks/mentions";
import { PERM } from "applesauce-concord";
import type { BlobPointer, ChannelMetadata, PermName, Role } from "applesauce-concord";
import { hasPerm, parsePermissions } from "applesauce-concord/helpers";
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

// Each page below subscribes only the slices it renders, never the aggregate
// `state$` — that re-emits on every chat message (presence moves the member set),
// which would re-render the roles and channels UI on every message. These stable
// empties keep a slice's pre-fold value from being a fresh identity each render.
const NO_ROLES: Role[] = [];
const NO_CHANNELS: ChannelMetadata[] = [];
const NO_MEMBERS: ReadonlySet<string> = new Set();
const NO_GRANTS: ReadonlyMap<string, string[]> = new Map();

/** Full-page community settings, with a sub-page per admin area. */
export function CommunitySettingsView({
  cid,
  page: pageParam,
  mobileNav,
  onSelectPage,
  onClose,
}: {
  cid: string;
  page: string;
  mobileNav: ReactNode;
  onSelectPage: (page: PageId) => void;
  onClose: () => void;
}) {
  const account = useActiveAccount();
  const community = useCommunity(cid);
  const metadata = use$(community?.metadata$);
  // The Advanced page (Refounding etc.) is a developer-only area — hide it from
  // the nav, and refuse to render it via a direct URL, unless dev mode is on.
  const devMode = useDevMode();
  const visiblePages = devMode ? PAGES : PAGES.filter((p) => p.id !== "advanced");
  // Fall back to the overview page for an unknown/empty/hidden page value.
  const page: PageId = visiblePages.some((p) => p.id === pageParam) ? (pageParam as PageId) : "overview";

  if (!community) return null;
  const name = metadata?.name ?? community.material.name;
  const isOwner = account?.pubkey === community.material.owner;

  return (
    <div className="flex-1 flex min-w-0 bg-base-100 max-md:flex-col">
      <nav className="w-58 shrink-0 bg-base-200 px-2.5 py-4 overflow-y-auto flex flex-col gap-0.5 max-md:w-full max-md:flex-row max-md:items-center max-md:gap-1 max-md:py-2 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-base-300">
        {mobileNav}
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-3 text-[11px] uppercase font-bold tracking-wide opacity-60 max-md:p-0 max-md:pr-1 max-md:shrink-0">
          <CommunityIcon name={name} icon={metadata?.icon} />
          <span className="max-md:hidden">{name}</span>
        </div>
        {visiblePages.map((p) => (
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
          {page === "overview" && <OverviewPage cid={cid} isOwner={isOwner} onClose={onClose} />}
          {page === "roles" && <RolesPage cid={cid} />}
          {page === "members" && <MembersPage cid={cid} />}
          {page === "channels" && <ChannelsPage cid={cid} />}
          {page === "advanced" && <AdvancedPage cid={cid} />}
        </div>
      </div>
    </div>
  );
}

function CommunityIcon({ name, icon }: { name: string; icon: BlobPointer | undefined }) {
  const iconUrl = useDecryptedImage(icon);
  return (
    <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg overflow-hidden bg-base-300 font-semibold text-base-content shrink-0 text-[11px]">
      {iconUrl ? <img className="w-full h-full object-cover" src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
    </span>
  );
}

// ---- Overview (metadata + images + dissolve) -----------------------------

function OverviewPage({ cid, isOwner, onClose }: { cid: string; isOwner: boolean; onClose: () => void }) {
  const client = useConcord();
  const account = useActiveAccount();
  const community = useCommunity(cid);
  const navigate = useNavigate();
  const metadata = use$(community?.metadata$);
  const dissolved = use$(community?.dissolved$) ?? false;
  const canManageMetadata = use$(() => community?.can$(PERM.MANAGE_METADATA), [community]) ?? false;
  const [name, setName] = useState(() => metadata?.name ?? community?.material.name ?? "");
  const [description, setDescription] = useState(() => metadata?.description ?? "");
  const [blossom, setBlossom] = useState(() => (metadata?.blossom_servers ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);

  // Leaving is available to every member (no permission needed) — tombstone the
  // membership, purge the community's decrypted rumor caches and read cursors
  // (which are meaningless once the plaintext is gone), then leave settings.
  async function leave() {
    await client.leave(cid);
    await deleteCommunityRumorCache(cid);
    if (account) clearCommunityReadState(account.pubkey, cid);
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
    await community?.admin.editMetadata({ name: name.trim(), description: description.trim(), blossom_servers });
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
          <div className="flex flex-wrap gap-5 items-start">
            <ImageField cid={cid} which="icon" pointer={metadata?.icon} disabled={dissolved} />
            <ImageField cid={cid} which="banner" pointer={metadata?.banner} disabled={dissolved} />
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
        <div className="rounded-box bg-base-200 border border-base-300 p-3 font-mono text-xs break-all opacity-70">{cid}</div>
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
                await community?.admin.dissolve();
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
      await community?.admin.setCommunityImage(which, file);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const previewSize = which === "icon" ? "w-16 h-16 rounded-xl" : "w-40 h-16 rounded-lg max-sm:w-32";
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
            onClick={() => community?.admin.removeCommunityImage(which)}
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

function RolesPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const roles = use$(community?.roles$) ?? NO_ROLES;
  const dissolved = use$(community?.dissolved$) ?? false;
  const canManageRoles = use$(() => community?.can$(PERM.MANAGE_ROLES), [community]) ?? false;
  // A deleted role confers no permissions or rank but stays in `roles$` so history
  // can still resolve it — it has no place in an editor listing live roles.
  const serverRoles = roles.filter((r) => r.scope.kind === "server" && !r.deleted).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const [tab, setTab] = useState<string>(serverRoles[0]?.role_id ?? "new");

  const selectedRole = serverRoles.find((r) => r.role_id === tab);
  const activeTab = selectedRole ? selectedRole.role_id : "new";
  const canCreate = canManageRoles && !dissolved;

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Roles</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">Roles bundle permissions you can grant to members. The owner is always supreme.</p>
      <div className="tabs tabs-boxed mb-5 overflow-x-auto flex-nowrap">
        {serverRoles.map((r) => (
          <button key={r.role_id} className={`tab shrink-0 ${activeTab === r.role_id ? "tab-active" : ""}`} onClick={() => setTab(r.role_id)}>
            {r.name}
          </button>
        ))}
        <button className={`tab shrink-0 ${activeTab === "new" ? "tab-active" : ""}`} onClick={() => setTab("new")}>
          New role
        </button>
      </div>

      {activeTab === "new" ? (
        <NewRolePanel cid={cid} roleCount={roles.length} canCreate={canCreate} />
      ) : selectedRole ? (
        <RolePanel cid={cid} role={selectedRole} dissolved={dissolved} onDeleted={() => setTab("new")} />
      ) : null}
    </>
  );
}

function NewRolePanel({ cid, roleCount, canCreate }: { cid: string; roleCount: number; canCreate: boolean }) {
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
    const position = roleCount + 1;
    await community?.admin.createRole(name.trim(), position, bits);
    setName("");
    setPerms(new Set());
    setBusy(false);
  }

  return (
    <>
      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mb-2">Create role</h3>
      {!canCreate && <p className="text-sm opacity-70 leading-relaxed mb-5">You need Manage Roles permission to create roles.</p>}
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Role name</label>
        <input className="input input-bordered w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="Moderator" maxLength={64} disabled={!canCreate} />
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Permissions</label>
        {(Object.keys(PERM) as PermName[]).map((p) => (
          <div key={p} className="flex items-center gap-2.5 py-1">
            <input type="checkbox" className="checkbox checkbox-sm" id={`new-${p}`} checked={perms.has(p)} onChange={() => toggle(p)} disabled={!canCreate} />
            <label htmlFor={`new-${p}`} className="cursor-pointer text-sm">
              {PERM_LABELS[p]}
            </label>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3.5 mt-5">
        <button className="btn btn-primary" onClick={create} disabled={!canCreate || !name.trim() || busy}>
          Create role
        </button>
      </div>
    </>
  );
}

function RolePanel({ cid, role, dissolved, onDeleted }: { cid: string; role: Role; dissolved: boolean; onDeleted: () => void }) {
  const community = useCommunity(cid);
  const members = use$(community?.members$) ?? NO_MEMBERS;
  const grants = use$(community?.grants$) ?? NO_GRANTS;
  const canManageRole = use$(() => community?.can$(PERM.MANAGE_ROLES, role.position), [community, role.position]) ?? false;
  const [seededRole, setSeededRole] = useState(role.role_id);
  const [name, setName] = useState(role.name);
  const [position, setPosition] = useState(String(role.position));
  const [color, setColor] = useState(role.color ? `#${role.color.toString(16).padStart(6, "0")}` : "#5865f2");
  const [perms, setPerms] = useState<Set<PermName>>(() => rolePermSet(role));
  const [memberQuery, setMemberQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (role.role_id !== seededRole) {
    setSeededRole(role.role_id);
    setName(role.name);
    setPosition(String(role.position));
    setColor(role.color ? `#${role.color.toString(16).padStart(6, "0")}` : "#5865f2");
    setPerms(rolePermSet(role));
    setMemberQuery("");
    setSaved(false);
  }

  const canManage = canManageRole && !dissolved;
  const holders = [...members].filter((m) => (grants.get(m) ?? []).includes(role.role_id)).sort();
  const candidates = useMentionCandidates([...members].filter((m) => m !== community?.material.owner && !holders.includes(m)).sort());
  const search = useMentionSearch(candidates);
  const results = search(memberQuery);

  function toggle(p: PermName) {
    const next = new Set(perms);
    if (next.has(p)) next.delete(p);
    else next.add(p);
    setPerms(next);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setSaved(false);
    let bits = 0n;
    for (const p of perms) bits |= PERM[p];
    const parsedColor = Number.parseInt(color.replace(/^#/, ""), 16);
    await community?.admin.editRole(role.role_id, {
      name: name.trim(),
      position: Math.max(1, Number.parseInt(position, 10) || role.position),
      permissions: bits.toString(),
      color: Number.isFinite(parsedColor) ? parsedColor : 0,
    });
    setBusy(false);
    setSaved(true);
  }

  async function removeMember(member: string) {
    const next = (grants.get(member) ?? []).filter((rid) => rid !== role.role_id);
    await community?.admin.grantRoles(member, next);
  }

  async function addMember(member: string) {
    const next = new Set(grants.get(member) ?? []);
    next.add(role.role_id);
    await community?.admin.grantRoles(member, [...next]);
    setMemberQuery("");
  }

  return (
    <>
      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mb-2">Edit role</h3>
      {!canManage && <p className="text-sm opacity-70 leading-relaxed mb-5">You need Manage Roles permission and must outrank this role to edit it.</p>}
      <div className="grid grid-cols-2 gap-4 mb-4 max-sm:grid-cols-1">
        <div>
          <label className="label text-xs font-semibold uppercase opacity-70">Role name</label>
          <input className="input input-bordered w-full" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} maxLength={64} disabled={!canManage} />
        </div>
        <div>
          <label className="label text-xs font-semibold uppercase opacity-70">Position</label>
          <input className="input input-bordered w-full" type="number" min={1} value={position} onChange={(e) => { setPosition(e.target.value); setSaved(false); }} disabled={!canManage} />
        </div>
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Color</label>
        <input className="input input-bordered w-full max-w-40" type="color" value={color} onChange={(e) => { setColor(e.target.value); setSaved(false); }} disabled={!canManage} />
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Permissions</label>
        {(Object.keys(PERM) as PermName[]).map((p) => (
          <div key={p} className="flex items-center gap-2.5 py-1">
            <input type="checkbox" className="checkbox checkbox-sm" id={`${role.role_id}-${p}`} checked={perms.has(p)} onChange={() => toggle(p)} disabled={!canManage} />
            <label htmlFor={`${role.role_id}-${p}`} className="cursor-pointer text-sm">
              {PERM_LABELS[p]}
            </label>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-3.5 mt-5 mb-7">
        <button className="btn btn-primary" onClick={save} disabled={!canManage || !name.trim() || busy}>
          {busy ? "Saving…" : "Save changes"}
        </button>
        {saved && <span className="text-success text-sm font-semibold">Saved ✓</span>}
        <button className="btn btn-error btn-outline gap-2 ml-auto" onClick={() => setDeleteOpen(true)} disabled={!canManage || busy}>
          <Trash2 size={16} />
          Delete role
        </button>
      </div>

      {deleteOpen && (
        <ConfirmModal
          title={`Delete ${role.name}?`}
          danger
          confirmLabel="Delete role"
          onClose={() => setDeleteOpen(false)}
          onConfirm={async () => {
            await community?.admin.deleteRole(role.role_id);
            onDeleted();
          }}
          body={
            <p>
              <strong>{role.name}</strong> stops conferring its permissions and rank to the{" "}
              {holders.length} member{holders.length === 1 ? "" : "s"} holding it, and disappears
              from this list. It stays readable in history, and members keep the grant itself — so
              restoring the role would hand their authority straight back.
            </p>
          }
        />
      )}

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Members</h3>
      {holders.length === 0 && <p className="text-sm opacity-70 leading-relaxed mb-3">No members have this role.</p>}
      {holders.map((m) => (
        <div key={m} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200">
          <UserAvatar pubkey={m} />
          <div className="font-medium min-w-0 truncate"><UserName pubkey={m} /></div>
          <button className="btn btn-ghost btn-sm ml-auto" onClick={() => removeMember(m)} disabled={!canManage}>
            Remove
          </button>
        </div>
      ))}

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Add member</h3>
      <input className="input input-bordered w-full" value={memberQuery} onChange={(e) => setMemberQuery(e.target.value)} placeholder="Search members by name or npub" disabled={!canManage} />
      {canManage && (
        <div className="mt-2 rounded-box border border-base-300 overflow-hidden">
          {results.length === 0 ? (
            <div className="p-3 text-sm opacity-70">No matching members.</div>
          ) : (
            results.map((c) => (
              <button key={c.pubkey} className="w-full flex items-center gap-2.5 p-2 hover:bg-base-200 text-left min-w-0" onClick={() => addMember(c.pubkey)}>
                <UserAvatar pubkey={c.pubkey} />
                <span className="font-medium truncate">{c.name}</span>
                <span className="text-xs opacity-60 ml-auto truncate max-sm:hidden">{c.npub}</span>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}

function rolePermSet(role: Role): Set<PermName> {
  const bits = parsePermissions(role.permissions);
  return new Set((Object.keys(PERM) as PermName[]).filter((p) => hasPerm(bits, PERM[p])));
}

// ---- Members -------------------------------------------------------------

/**
 * One member's row. The authority to act on *this* member is asked per row via
 * `canModerate$`, which folds in both halves of the CORD-04 rule — hold the bit
 * AND strictly outrank the target — plus the fact that you never outrank
 * yourself. That covers the owner (position 0, so nobody outranks them) without
 * a separate isOwner guard, and it re-emits if a role grant changes the answer.
 */
function MemberRow({
  cid,
  member,
  serverRoles,
  banned,
  canManageRoles,
  onBan,
}: {
  cid: string;
  member: string;
  serverRoles: Role[];
  banned: boolean;
  canManageRoles: boolean;
  onBan: () => void;
}) {
  const community = useCommunity(cid);
  const grants = use$(community?.grants$) ?? NO_GRANTS;
  const canKick = use$(() => community?.canModerate$(member, PERM.KICK), [community, member]) ?? false;
  const canBan = use$(() => community?.canModerate$(member, PERM.BAN), [community, member]) ?? false;
  const isOwner = member === community?.material.owner;
  const held = new Set(grants.get(member) ?? []);

  return (
    <div className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200 flex-wrap max-sm:items-start">
      <UserAvatar pubkey={member} />
      <div>
        <div className="font-medium">
          <UserName pubkey={member} />
        </div>
        {isOwner && <span className="badge badge-warning badge-sm">Owner</span>}
      </div>
      <div className="ml-auto flex gap-1.5 max-sm:ml-[42px] max-sm:w-[calc(100%-42px)] max-sm:flex-wrap max-sm:justify-end">
        {canKick && (
          <button className="btn btn-ghost btn-sm" onClick={() => community?.admin.kick(member)}>
            Kick
          </button>
        )}
        {canBan &&
          (banned ? (
            <button className="btn btn-ghost btn-sm" onClick={() => community?.admin.unban(member)}>
              Unban
            </button>
          ) : (
            <button className="btn btn-error btn-sm" onClick={onBan}>
              Ban
            </button>
          ))}
      </div>
      {!isOwner && canManageRoles && serverRoles.length > 0 && (
        <div className="w-full flex gap-1.5 flex-wrap pl-[42px] max-sm:pl-0">
          {serverRoles.map((r) => {
            const on = held.has(r.role_id);
            return (
              <button
                key={r.role_id}
                className={`badge badge-sm cursor-pointer ${on ? "badge-primary" : "badge-ghost"}`}
                onClick={() => {
                  const next = new Set(held);
                  if (on) next.delete(r.role_id);
                  else next.add(r.role_id);
                  community?.admin.grantRoles(member, [...next]);
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
}

function MembersPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const members = use$(community?.members$) ?? NO_MEMBERS;
  const roles = use$(community?.roles$) ?? NO_ROLES;
  const banlist = use$(community?.banlist$) ?? NO_MEMBERS;
  const dissolved = use$(community?.dissolved$) ?? false;
  // Whether the caller holds the bit at all, which gates the section. Whether they
  // may use it on a *particular* member is that row's own canModerate$ question.
  const canBanAny = use$(() => community?.can$(PERM.BAN), [community]) ?? false;
  const canManageRoles = (use$(() => community?.can$(PERM.MANAGE_ROLES), [community]) ?? false) && !dissolved;
  const serverRoles = roles.filter((r) => r.scope.kind === "server" && !r.deleted).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const [banTarget, setBanTarget] = useState<string | null>(null);

  const doBan = async (member: string) => {
    // 1. Soft ban: banlist + strip roles (CORD-04).
    await community?.admin.ban(member);
    // 2. Hard enforcement: Refound to sever the banned member's keys from
    //    the control plane and every channel (CORD-06 §3). keep = everyone
    //    still in the community except the banned member.
    const keep = [...members].filter((m) => m !== member);
    await community?.admin.refound({ keep, exclude: [member] });
  };

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Members</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">Everyone in the community. Assign roles, or kick and ban members.</p>
      {[...members].map((m) => (
        <MemberRow
          key={m}
          cid={cid}
          member={m}
          serverRoles={serverRoles}
          banned={banlist.has(m)}
          canManageRoles={canManageRoles}
          onBan={() => setBanTarget(m)}
        />
      ))}
      {members.size === 0 && <p className="text-sm opacity-70 leading-relaxed mb-5">No members yet.</p>}
      {banlist.size > 0 && (
        <>
          <h2 className="text-2xl font-bold mb-1 mt-6">Banned members</h2>
          <p className="text-sm opacity-70 leading-relaxed mb-5">
            Banned members can't rejoin. Unban removes them from the banlist; to let them back in,
            mint a fresh invite from the sidebar (the link carries current keys, so they rejoin
            without access to history from before the refounding).
          </p>
          {[...banlist].sort().map((m) => (
            <div key={m} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200 max-sm:flex-wrap">
              <UserAvatar pubkey={m} />
              <div>
                <div className="font-medium">
                  <UserName pubkey={m} />
                </div>
                <span className="badge badge-error badge-sm">
                  Banned
                </span>
              </div>
              <div className="ml-auto max-sm:ml-[42px] max-sm:w-[calc(100%-42px)] max-sm:text-right">
                {canBanAny && (
                  <button className="btn btn-ghost btn-sm" onClick={() => community?.admin.unban(m)}>
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

function ChannelsPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const channels = use$(community?.channels$) ?? NO_CHANNELS;
  const roles = use$(community?.roles$) ?? NO_ROLES;
  const members = use$(community?.members$) ?? NO_MEMBERS;
  const grants = use$(community?.grants$) ?? NO_GRANTS;
  const canManage = use$(() => community?.can$(PERM.MANAGE_CHANNELS), [community]) ?? false;
  const owner = community?.material.owner ?? "";
  // `channels$` is already live-only, so a deleted channel never reaches here.
  const privateChannels = channels.filter((c) => c.private);
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
      const rid = channelRoleId(channelId, roles);
      if (rid) {
        const next = new Set(grants.get(member) ?? []);
        next.add(rid);
        await community.admin.grantRoles(member, [...next]);
      }
      await community.admin.grantChannelAccess(channelId, member);
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
    const rid = channelRoleId(channelId, roles);
    if (rid) {
      const next = new Set(grants.get(member) ?? []);
      next.delete(rid);
      await community.admin.grantRoles(member, [...next]);
    }
    const keep = channelRoster(channelId, owner, roles, members, grants).filter((m) => m !== member);
    await community.admin.rotateChannel(channelId, { keep, exclude: [member] });
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
        const roster = channelRoster(ch.channel_id, owner, roles, members, grants);
        const rosterSet = new Set(roster);
        const outsiders = [...members].filter((m) => !rosterSet.has(m)).sort();
        return (
          <div key={ch.channel_id} className="mb-7">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <Lock size={16} />
              <strong>{ch.name}</strong>
              <span className="text-sm opacity-70">
                {roster.length} member{roster.length === 1 ? "" : "s"}
              </span>
              {canManage && (
                <button
                  className="btn btn-error btn-sm ml-auto max-sm:ml-0"
                  onClick={() => setDeleteTarget({ id: ch.channel_id, name: ch.name })}
                >
                  <Trash2 size={14} /> Delete
                </button>
              )}
            </div>
            {roster.map((m) => (
              <div key={m} className="flex items-center gap-2.5 p-2 rounded-lg hover:bg-base-200 max-sm:flex-wrap">
                <UserAvatar pubkey={m} />
                <div>
                  <div className="font-medium">
                    <UserName pubkey={m} />
                  </div>
                  {m === owner && <span className="badge badge-warning badge-sm">Owner</span>}
                </div>
                {canManage && m !== owner && (
                  <div className="ml-auto max-sm:ml-[42px] max-sm:w-[calc(100%-42px)] max-sm:text-right">
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
            await community?.admin.deleteChannel(deleteTarget.id);
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

function AdvancedPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const members = use$(community?.members$) ?? NO_MEMBERS;
  const metadata = use$(community?.metadata$);
  // Refounding requires ownership or BAN; the owner holds every bit, so asking
  // for BAN covers both.
  const canRekey = use$(() => community?.can$(PERM.BAN), [community]) ?? false;
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
      await community?.admin.refound({ keep: [...members] });
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
                This rotates <strong>{metadata?.name ?? community?.material.name}</strong> to
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
