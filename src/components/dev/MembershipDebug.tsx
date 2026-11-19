/**
 * Membership tab of the community Debug page. Shows only what `@applesauce/concord`
 * exposes: the folded member set, Banlist and ban times, each pubkey's standing and
 * verified staff status, and the raw Guestbook rumors that mention it. It does not
 * interpret Guestbook entries; per-member fold explanations are an upstream gap
 * (`.planning/concord-membership-explanation-gap.md`).
 */
import { Fragment, useMemo, useState } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { CommunityState, ConcordCommunity, Role, Rumor } from "@applesauce/concord";
import {
  isCurrentStaff,
  isStaffPermissionMask,
  JOIN_LEAVE_KIND,
  KICK_KIND,
  permNames,
  rumorMs,
  SNAPSHOT_KIND,
  snapshotAuthorities,
  type Standing,
} from "@applesauce/concord/helpers";
import { ChevronRight } from "lucide-react";
import { useCommunity } from "../../hooks/use-community";
import { stringify, dateTime, type EpochAudit } from "../../helpers/concord-history";
import { toClipboard } from "../../helpers/community-debug-report";
import { formatTime } from "../../helpers/util";
import { UserLabel } from "../User";
import { CopyButton, DebugSection as Card, Hex, KV } from "./debug-ui";

const KIND_LABEL: Record<number, string> = { [JOIN_LEAVE_KIND]: "join/leave", [KICK_KIND]: "kick", [SNAPSHOT_KIND]: "snapshot" };
const kindLabel = (kind: number) => KIND_LABEL[kind] ?? String(kind);

const NO_RUMORS: Rumor[] = [];

type Row = {
  pubkey: string;
  present: boolean;
  banned: boolean;
  bannedAtMs?: number;
  standing: Standing;
  staff: boolean;
  currentStaff: boolean;
  /** Guestbook rumors whose author, tags or content contain the pubkey. */
  guestbook: Rumor[];
};

type Filter = "all" | "present" | "absent" | "banned" | "staff" | "unverified";
type Sort = "rank" | "guestbook";

const FILTERS: { id: Filter; label: string; test: (r: Row) => boolean; tone?: string }[] = [
  { id: "all", label: "all", test: () => true },
  { id: "present", label: "present", test: (r) => r.present },
  { id: "absent", label: "absent", test: (r) => !r.present && !r.banned },
  { id: "banned", label: "banned", test: (r) => r.banned, tone: "text-error" },
  { id: "staff", label: "staff", test: (r) => r.staff },
  { id: "unverified", label: "staff unverified", test: (r) => r.staff && !r.currentStaff, tone: "text-warning" },
];

function mentions(r: Rumor, pk: string): boolean {
  return r.pubkey === pk || r.content.includes(pk) || r.tags.some((t) => t.includes(pk));
}

function buildRows(community: ConcordCommunity, state: CommunityState, guestbook: Rumor[]): Row[] {
  const pubkeys = new Set<string>([
    state.material.owner,
    ...state.members,
    ...state.banlist,
    ...(state.bannedAt?.keys() ?? []),
    ...state.grants.keys(),
    ...guestbook.map((r) => r.pubkey),
  ]);
  return [...pubkeys].map((pk) => {
    const standing = community.standingOf(pk);
    const at = state.bannedAt?.get(pk);
    return {
      pubkey: pk,
      present: state.members.has(pk),
      banned: state.banlist.has(pk),
      bannedAtMs: at !== undefined ? at * 1000 : undefined,
      standing,
      staff: standing.isOwner || isStaffPermissionMask(standing.permissions),
      currentStaff: isCurrentStaff(state, pk),
      guestbook: guestbook.filter((r) => mentions(r, pk)).sort((a, b) => rumorMs(a) - rumorMs(b)),
    };
  });
}

function RoleBadge({ role }: { role: Role | undefined }) {
  if (!role) return <span className="badge badge-sm badge-ghost">unknown role</span>;
  const style = role.color ? { backgroundColor: `#${role.color.toString(16).padStart(6, "0")}`, color: "#fff", borderColor: "transparent" } : undefined;
  return (
    <span className={`badge badge-sm ${role.deleted ? "opacity-50 line-through" : ""}`} style={style} title={`pos ${role.position}`}>
      {role.name}
    </span>
  );
}

function EpochStrip({ pubkey, audits }: { pubkey: string; audits: EpochAudit[] }) {
  return (
    <span className="inline-flex gap-0.5">
      {audits.map((a, i) => {
        const member = a.state.members.has(pubkey);
        const tip = i === audits.length - 1;
        const rekeyed = a.rotations.some((r) => r.rekeyed.includes(pubkey));
        const cls = !member ? "bg-base-300" : tip || rekeyed ? "bg-success" : "bg-warning";
        const label = !member ? "not member" : tip ? "member" : rekeyed ? `member, rekeyed → ${a.epoch + 1}` : `member, not rekeyed → ${a.epoch + 1}`;
        return <span key={a.epoch} className={`w-3 h-4 rounded-sm ${cls}`} title={`epoch ${a.epoch}: ${label}`} />;
      })}
    </span>
  );
}

function GuestbookTable({ rumors, subject }: { rumors: Rumor[]; subject?: string }) {
  if (rumors.length === 0) return <span className="opacity-50">—</span>;
  return (
    <div className="overflow-x-auto">
      <table className="table table-sm">
        <tbody>
          {rumors.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap">{dateTime(rumorMs(r))}</td>
              <td><span className="badge badge-sm badge-outline whitespace-nowrap">{kindLabel(r.kind)}</span></td>
              <td>{r.pubkey === subject ? <span className="opacity-50">self</span> : <UserLabel pubkey={r.pubkey} />}</td>
              <td className="font-mono max-w-80 truncate" title={r.content}>{r.content || <span className="opacity-40">""</span>}</td>
              <td className="font-mono opacity-70 max-w-80 truncate" title={stringify(r.tags)}>
                {r.tags.filter((t) => t[0] !== "ms").map((t) => t.map((v) => (v.length > 18 ? `${v.slice(0, 8)}…` : v)).join(":")).join(" ")}
              </td>
              <td><Hex value={r.id} /></td>
              <td><CopyButton text={() => stringify(r)} label="" title="Copy rumor JSON" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberRow({ row, self, rolesById, audits, cols }: { row: Row; self?: string; rolesById: Map<string, Role>; audits: EpochAudit[]; cols: number }) {
  const [open, setOpen] = useState(false);
  const { standing } = row;
  const last = row.guestbook[row.guestbook.length - 1];
  const perms = permNames(standing.permissions);
  return (
    <Fragment>
      <tr className={`cursor-pointer hover:bg-base-200 ${row.present ? "" : "opacity-70"}`} onClick={() => setOpen((o) => !o)}>
        <td className="w-6 px-1"><ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} /></td>
        <td>
          <div className="flex flex-wrap items-center gap-1.5">
            <UserLabel pubkey={row.pubkey} />
            {standing.isOwner && <span className="badge badge-sm badge-primary">owner</span>}
            {row.pubkey === self && <span className="badge badge-sm badge-secondary">you</span>}
          </div>
        </td>
        <td className="whitespace-nowrap">
          <span className={`badge badge-sm ${row.present ? "badge-success" : "badge-ghost"}`}>{row.present ? "present" : "absent"}</span>
          {row.banned && <span className="badge badge-sm badge-error ml-1">banned</span>}
          {!row.banned && row.bannedAtMs !== undefined && <span className="badge badge-sm badge-ghost ml-1">unbanned</span>}
        </td>
        <td>
          <span className="inline-flex flex-wrap items-center gap-1">
            {standing.roleIds.map((id) => <RoleBadge key={id} role={rolesById.get(id)} />)}
            {row.staff && !standing.isOwner && (
              <span className={`badge badge-sm ${row.currentStaff ? "badge-outline" : "badge-warning"}`}>{row.currentStaff ? "staff" : "staff unverified"}</span>
            )}
            {!standing.isOwner && standing.roleIds.length === 0 && <span className="opacity-40">—</span>}
          </span>
        </td>
        <td className="whitespace-nowrap">
          {last ? (
            <span title={dateTime(rumorMs(last))}>
              {row.guestbook.length} <span className="opacity-60">· {kindLabel(last.kind)}{last.kind === JOIN_LEAVE_KIND ? ` ${last.content.trim()}` : ""} {formatTime(rumorMs(last))}</span>
            </span>
          ) : (
            <span className="opacity-40">—</span>
          )}
        </td>
        {audits.length > 0 && <td><EpochStrip pubkey={row.pubkey} audits={audits} /></td>}
      </tr>
      {open && (
        <tr className="bg-base-200/40">
          <td />
          <td colSpan={cols - 1}>
            <div className="flex flex-col gap-3 py-2">
              <div className="flex flex-col gap-1">
                <div className="flex items-center">
                  <span className="font-semibold opacity-70">Standing</span>
                  <span className="ml-auto"><CopyButton text={() => toClipboard(row)} /></span>
                </div>
                <KV label="pubkey"><Hex value={row.pubkey} full /></KV>
                <KV label="position">{standing.isOwner ? "0 (owner)" : standing.roleIds.length ? standing.position : "—"}</KV>
                <KV label="permissions">{standing.isOwner ? "all" : perms.length ? perms.join(", ") : "—"}</KV>
                <KV label="current staff">{row.currentStaff ? "yes" : "no"}</KV>
                {row.bannedAtMs !== undefined && <KV label="banned at">{dateTime(row.bannedAtMs)}</KV>}
                {audits.length > 0 && (
                  <KV label="epochs">
                    <span className="inline-flex flex-wrap gap-1">
                      {audits.map((a, i) => {
                        const member = a.state.members.has(row.pubkey);
                        const next = i < audits.length - 1 ? a.rotations.map((r) => (r.rekeyed.includes(row.pubkey) ? "rekeyed" : r.notRekeyed.includes(row.pubkey) ? "missed" : null)) : [];
                        return (
                          <span key={a.epoch} className={`badge badge-sm ${member ? "badge-success" : "badge-ghost"}`}>
                            {a.epoch}{next.filter(Boolean).map((n) => ` → ${n}`).join("")}
                          </span>
                        );
                      })}
                    </span>
                  </KV>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-semibold opacity-70">Guestbook rumors mentioning this pubkey</span>
                <GuestbookTable rumors={row.guestbook} subject={row.pubkey} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function MembershipDebug({ cid, audits = [] }: { cid: string; audits?: EpochAudit[] }) {
  const community = useCommunity(cid);
  const self = useActiveAccount()?.pubkey;
  const state = use$(() => community?.state$, [community]) as CommunityState | undefined;
  const guestbook = (use$(() => community?.guestbookStore.timeline([{}]), [community]) as Rumor[] | undefined) ?? NO_RUMORS;
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("rank");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => (community && state ? buildRows(community, state, guestbook) : []), [community, state, guestbook]);
  const rolesById = useMemo(() => new Map((state?.roles ?? []).map((r) => [r.role_id, r])), [state]);

  if (!community || !state) return <p className="opacity-60">Loading…</p>;

  const q = query.trim().toLowerCase();
  const active = FILTERS.find((f) => f.id === filter)!;
  const rank = (r: Row) => (r.standing.isOwner ? -1 : r.standing.roleIds.length ? r.standing.position : Number.MAX_SAFE_INTEGER);
  const lastMs = (r: Row) => (r.guestbook.length ? rumorMs(r.guestbook[r.guestbook.length - 1]) : 0);
  const visible = rows
    .filter((r) => active.test(r) && (!q || r.pubkey.includes(q) || r.standing.roleIds.some((id) => rolesById.get(id)?.name.toLowerCase().includes(q))))
    .sort((a, b) => {
      if (a.present !== b.present) return a.present ? -1 : 1;
      if (sort === "guestbook") return lastMs(b) - lastMs(a);
      return rank(a) - rank(b) || lastMs(b) - lastMs(a);
    });

  const byKind = new Map<string, number>();
  for (const r of guestbook) byKind.set(kindLabel(r.kind), (byKind.get(kindLabel(r.kind)) ?? 0) + 1);
  const authorities = [...snapshotAuthorities(state.material)];
  const cols = audits.length > 0 ? 6 : 5;

  return (
    <>
      <Card
        title="Membership"
        summary={`${state.members.size} present · ${rows.length} known · epoch ${state.material.root_epoch}`}
        copy={() => toClipboard({ epoch: state.material.root_epoch, snapshot_authorities: authorities, rows: visible })}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 opacity-80">
          <span>guestbook: {guestbook.length ? [...byKind].map(([k, n]) => `${n} ${k}`).join(" · ") : "empty"}</span>
          {authorities.length > 0 && (
            <span className="inline-flex items-center gap-1">snapshot authorities: {authorities.map((a) => <UserLabel key={a} pubkey={a} />)}</span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap gap-1">
            {FILTERS.map((f) => {
              const n = rows.filter(f.test).length;
              if (n === 0 && f.id !== "all" && f.id !== filter) return null;
              return (
                <button
                  key={f.id}
                  className={`btn btn-xs ${filter === f.id ? "btn-active" : "btn-ghost"} ${n > 0 && f.tone ? f.tone : ""}`}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label} <span className="opacity-60">{n}</span>
                </button>
              );
            })}
          </div>
          <input className="input input-bordered input-sm flex-1 min-w-40 font-mono" placeholder="pubkey or role" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="select select-bordered select-sm w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
            <option value="rank">rank</option>
            <option value="guestbook">guestbook time</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="table table-sm text-base">
            <thead>
              <tr>
                <th />
                <th>Member</th>
                <th>State</th>
                <th>Roles</th>
                <th>Guestbook</th>
                {audits.length > 0 && <th>Epochs {audits[0].epoch}–{audits[audits.length - 1].epoch}</th>}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <MemberRow key={r.pubkey} row={r} self={self} rolesById={rolesById} audits={audits} cols={cols} />
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="opacity-60 py-4 text-center">—</p>}
        </div>
      </Card>

      <Card title="Guestbook" summary={`${guestbook.length} rumors`} copy={() => stringify([...guestbook].sort((a, b) => rumorMs(a) - rumorMs(b)))}>
        <GuestbookTable rumors={[...guestbook].sort((a, b) => rumorMs(b) - rumorMs(a))} />
      </Card>
    </>
  );
}
