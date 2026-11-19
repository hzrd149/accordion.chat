/**
 * Membership tab of the community Debug page: every pubkey the community knows
 * about (members, departed, banned, role holders, active authors), each with its
 * fold verdict, the Guestbook entry that decided it, roles and verification,
 * activity per plane, and — once the relay audit has run — per-epoch membership
 * and rekey coverage. Rows expand to the full Guestbook trace.
 */
import { Fragment, useMemo, useState } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { CommunityState, Role } from "@applesauce/concord";
import { JOIN_LEAVE_KIND, KICK_KIND, permNames, snapshotAuthorities } from "@applesauce/concord/helpers";
import { ChevronRight } from "lucide-react";
import { useCommunity } from "../../hooks/use-community";
import { foldActivity, GUESTBOOK_KINDS, traceMembers, type MemberBasis, type MemberTrace, type TraceEntry } from "../../helpers/member-trace";
import { useMemberActivityInputs } from "../../hooks/use-member-activity";
import { toClipboard } from "../../helpers/community-debug-report";
import { dateTime, type EpochAudit } from "../../helpers/concord-history";
import { formatTime } from "../../helpers/util";
import { UserLabel } from "../User";
import { CopyButton, DebugSection as Card, Hex, KV } from "./debug-ui";

const BASIS_CLASS: Record<MemberBasis, string> = {
  join: "badge-success",
  snapshot: "badge-success badge-outline",
  activity: "badge-success badge-dash",
  left: "badge-ghost",
  kicked: "badge-warning",
  banned: "badge-error",
  "stale pre-ban": "badge-warning badge-outline",
  "no record": "badge-ghost badge-dash",
};

const VERB_CLASS: Record<TraceEntry["verb"], string> = {
  join: "badge-success",
  leave: "badge-ghost",
  kick: "badge-warning",
  snapshot: "badge-info",
};

type Filter = "all" | "present" | "departed" | "banned" | "staff" | "unverified" | "mismatch" | "ignored";
type Sort = "rank" | "activity" | "decided";

const FILTERS: { id: Filter; label: string; test: (t: MemberTrace) => boolean; tone?: string }[] = [
  { id: "all", label: "all", test: () => true },
  { id: "present", label: "present", test: (t) => t.present },
  { id: "departed", label: "absent", test: (t) => !t.present && !t.banned },
  { id: "banned", label: "banned", test: (t) => t.banned, tone: "text-error" },
  { id: "staff", label: "staff", test: (t) => t.staff },
  { id: "unverified", label: "unverified grant", test: (t) => t.grantUnverified, tone: "text-warning" },
  { id: "ignored", label: "ignored entries", test: (t) => t.entries.some((e) => e.outcome === "ignored"), tone: "text-warning" },
  { id: "mismatch", label: "fold mismatch", test: (t) => t.present !== t.foldPresent, tone: "text-error" },
];

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

function TraceDetail({ t, rolesById, audits }: { t: MemberTrace; rolesById: Map<string, Role>; audits: EpochAudit[] }) {
  const perms = permNames(t.standing.permissions);
  return (
    <div className="grid gap-4 lg:grid-cols-2 py-2">
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="font-semibold opacity-70">Guestbook</span>
        {t.entries.length === 0 ? (
          <span className="opacity-50">—</span>
        ) : (
          <table className="table table-sm">
            <tbody>
              {t.entries.map((e, i) => (
                <tr key={`${e.rumorId}:${i}`} className={e.outcome === "ignored" ? "opacity-60" : undefined}>
                  <td className="whitespace-nowrap">{dateTime(e.ms)}</td>
                  <td>
                    <span className={`badge badge-sm ${VERB_CLASS[e.verb]}`}>{e.verb}</span>
                    {e.size !== undefined && <span className="opacity-60 ml-1">{e.size}</span>}
                  </td>
                  <td>{e.author !== t.pubkey ? <UserLabel pubkey={e.author} /> : <span className="opacity-50">self</span>}</td>
                  <td>
                    {e.outcome === "decisive" ? (
                      <span className="badge badge-sm badge-primary">decisive</span>
                    ) : e.outcome === "ignored" ? (
                      <span className="badge badge-sm badge-error badge-outline">{e.reason}</span>
                    ) : (
                      <span className="badge badge-sm badge-ghost">superseded</span>
                    )}
                  </td>
                  <td><Hex value={e.rumorId} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="font-semibold opacity-70">Standing</span>
        <KV label="pubkey"><Hex value={t.pubkey} full /></KV>
        <KV label="position">{t.owner ? "0 (owner)" : t.standing.roleIds.length ? t.standing.position : "—"}</KV>
        <KV label="permissions">{t.owner ? "all" : perms.length ? perms.join(", ") : "—"}</KV>
        <KV label="display roles">
          <span className="inline-flex flex-wrap gap-1">{t.standing.roleIds.length ? t.standing.roleIds.map((id) => <RoleBadge key={id} role={rolesById.get(id)} />) : "—"}</span>
        </KV>
        <KV label="verified roles">
          <span className="inline-flex flex-wrap gap-1">
            {t.verifiedRoleIds === undefined ? "—" : t.verifiedRoleIds.length ? t.verifiedRoleIds.map((id) => <RoleBadge key={id} role={rolesById.get(id)} />) : "none"}
          </span>
        </KV>
        {t.bannedAtMs !== undefined && <KV label="banned at">{dateTime(t.bannedAtMs)}{!t.banned && <span className="badge badge-sm badge-ghost ml-2">lifted</span>}</KV>}
        <span className="font-semibold opacity-70 mt-2">Activity</span>
        {t.activity.length === 0 ? (
          <span className="opacity-50">—</span>
        ) : (
          t.activity.map((s) => (
            <KV key={s.label} label={s.label}>
              {s.count} · {dateTime(s.lastMs)}
            </KV>
          ))
        )}
        {audits.length > 0 && (
          <>
            <span className="font-semibold opacity-70 mt-2">Epochs</span>
            {audits.map((a, i) => {
              const member = a.state.members.has(t.pubkey);
              const rotations = a.rotations.map((r) => (r.rekeyed.includes(t.pubkey) ? "rekeyed" : r.notRekeyed.includes(t.pubkey) ? "missed" : "—"));
              return (
                <KV key={a.epoch} label={`epoch ${a.epoch}`}>
                  {member ? <span className="badge badge-sm badge-success">member</span> : <span className="badge badge-sm badge-ghost">absent</span>}
                  {i < audits.length - 1 && rotations.map((r, j) => (
                    <span key={j} className={`badge badge-sm ml-1 ${r === "rekeyed" ? "badge-success badge-outline" : r === "missed" ? "badge-warning" : "badge-ghost"}`}>→ {a.epoch + 1} {r}</span>
                  ))}
                </KV>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function MemberRow({ t, self, rolesById, audits, cols }: { t: MemberTrace; self?: string; rolesById: Map<string, Role>; audits: EpochAudit[]; cols: number }) {
  const [open, setOpen] = useState(false);
  const ignored = t.entries.filter((e) => e.outcome === "ignored").length;
  const counts = (["join", "leave", "kick", "snapshot"] as const)
    .map((v) => [v, t.entries.filter((e) => e.verb === v && e.outcome !== "ignored").length] as const)
    .filter(([, n]) => n > 0);
  const totalActivity = t.activity.reduce((n, s) => n + s.count, 0);
  const mismatch = t.present !== t.foldPresent;
  return (
    <Fragment>
      <tr className={`cursor-pointer hover:bg-base-200 ${t.present ? "" : "opacity-70"} ${mismatch ? "bg-error/10" : ""}`} onClick={() => setOpen((o) => !o)}>
        <td className="w-6 px-1"><ChevronRight size={14} className={`transition-transform ${open ? "rotate-90" : ""}`} /></td>
        <td className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <UserLabel pubkey={t.pubkey} />
            {t.owner && <span className="badge badge-sm badge-primary">owner</span>}
            {t.pubkey === self && <span className="badge badge-sm badge-secondary">you</span>}
          </div>
        </td>
        <td className="whitespace-nowrap">
          <span className={`badge badge-sm ${t.present ? "badge-success" : "badge-ghost"}`}>{t.present ? "present" : "absent"}</span>{" "}
          <span className={`badge badge-sm ${BASIS_CLASS[t.basis]}`}>{t.basis}</span>
          {mismatch && <span className="badge badge-sm badge-error ml-1" title="Replay verdict differs from the SDK">replay: {t.foldPresent ? "present" : "absent"}</span>}
        </td>
        <td className="whitespace-nowrap">
          {t.decisive ? (
            <span className="inline-flex items-center gap-1.5">
              <span className={`badge badge-sm ${VERB_CLASS[t.decisive.verb]}`}>{t.decisive.verb}</span>
              <span className="opacity-70" title={dateTime(t.decisive.ms)}>{formatTime(t.decisive.ms)}</span>
              {t.decisive.author !== t.pubkey && <span className="opacity-70">by <UserLabel pubkey={t.decisive.author} /></span>}
            </span>
          ) : (
            <span className="opacity-40">—</span>
          )}
        </td>
        <td>
          <span className="inline-flex flex-wrap items-center gap-1">
            {t.standing.roleIds.map((id) => <RoleBadge key={id} role={rolesById.get(id)} />)}
            {t.staff && !t.owner && <span className="badge badge-sm badge-outline">staff</span>}
            {t.grantUnverified && <span className="badge badge-sm badge-warning">unverified</span>}
            {!t.owner && t.standing.roleIds.length === 0 && <span className="opacity-40">—</span>}
          </span>
        </td>
        <td className="whitespace-nowrap">
          {t.lastActivityMs ? (
            <span title={t.activity.map((s) => `${s.label}: ${s.count}`).join("\n")}>
              {formatTime(t.lastActivityMs)} <span className="opacity-50">· {totalActivity}</span>
            </span>
          ) : (
            <span className="opacity-40">—</span>
          )}
        </td>
        <td className="whitespace-nowrap">
          {counts.map(([v, n]) => <span key={v} className="opacity-70 mr-1.5">{n}{v[0]}</span>)}
          {ignored > 0 && <span className="text-warning">{ignored}✕</span>}
          {counts.length === 0 && ignored === 0 && <span className="opacity-40">—</span>}
        </td>
        {audits.length > 0 && <td><EpochStrip pubkey={t.pubkey} audits={audits} /></td>}
      </tr>
      {open && (
        <tr className="bg-base-200/40">
          <td />
          <td colSpan={cols - 1}>
            <div className="flex justify-end">
              <CopyButton text={() => toClipboard(t)} />
            </div>
            <TraceDetail t={t} rolesById={rolesById} audits={audits} />
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
  const inputs = useMemberActivityInputs(cid);
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("rank");
  const [query, setQuery] = useState("");

  const guestbook = useMemo(() => (inputs?.[0]?.rumors ?? []).filter((r) => GUESTBOOK_KINDS.has(r.kind)), [inputs]);
  const traces = useMemo(() => (state && inputs ? traceMembers(state, guestbook, foldActivity(inputs)) : []), [state, inputs, guestbook]);
  const rolesById = useMemo(() => new Map((state?.roles ?? []).map((r) => [r.role_id, r])), [state]);

  if (!state || !inputs) return <p className="opacity-60">Loading…</p>;

  const q = query.trim().toLowerCase();
  const active = FILTERS.find((f) => f.id === filter)!;
  const rank = (t: MemberTrace) => (t.owner ? -1 : t.standing.roleIds.length ? t.standing.position : Number.MAX_SAFE_INTEGER);
  const visible = traces
    .filter((t) => active.test(t) && (!q || t.pubkey.includes(q) || t.standing.roleIds.some((id) => rolesById.get(id)?.name.toLowerCase().includes(q))))
    .sort((a, b) => {
      if (a.present !== b.present) return a.present ? -1 : 1;
      if (sort === "activity") return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
      if (sort === "decided") return (b.decisive?.ms ?? 0) - (a.decisive?.ms ?? 0);
      return rank(a) - rank(b) || (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
    });

  const verbs = { join: 0, leave: 0, kick: 0, snapshot: 0 };
  for (const r of guestbook) {
    if (r.kind === JOIN_LEAVE_KIND) verbs[r.content.trim() === "leave" ? "leave" : "join"]++;
    else if (r.kind === KICK_KIND) verbs.kick++;
    else verbs.snapshot++;
  }
  const authorities = [...snapshotAuthorities(state.material)];
  const cols = audits.length > 0 ? 8 : 7;

  return (
    <Card
      title="Membership"
      summary={`${state.members.size} present · ${traces.length} known · epoch ${state.material.root_epoch}`}
      copy={() => toClipboard({ epoch: state.material.root_epoch, guestbook: verbs, snapshot_authorities: authorities, members: visible })}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 opacity-80">
        <span>guestbook: {verbs.join} join · {verbs.leave} leave · {verbs.kick} kick · {verbs.snapshot} snapshot</span>
        {inputs.slice(1).map((s) => (
          <span key={s.label}>{s.label}: {s.rumors.length}</span>
        ))}
        {authorities.length > 0 && (
          <span className="inline-flex items-center gap-1">snapshot authorities: {authorities.map((a) => <UserLabel key={a} pubkey={a} />)}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((f) => {
            const n = traces.filter(f.test).length;
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
          <option value="activity">last activity</option>
          <option value="decided">guestbook time</option>
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="table table-sm text-base">
          <thead>
            <tr>
              <th />
              <th>Member</th>
              <th>State</th>
              <th>Decided by</th>
              <th>Roles</th>
              <th>Activity</th>
              <th>Guestbook</th>
              {audits.length > 0 && <th>Epochs {audits[0].epoch}–{audits[audits.length - 1].epoch}</th>}
            </tr>
          </thead>
          <tbody>
            {visible.map((t) => (
              <MemberRow key={t.pubkey} t={t} self={self} rolesById={rolesById} audits={audits} cols={cols} />
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p className="opacity-60 py-4 text-center">—</p>}
      </div>
    </Card>
  );
}
