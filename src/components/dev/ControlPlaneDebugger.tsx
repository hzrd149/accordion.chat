/**
 * Control Plane Debugger — a developer tool to inspect a community's control
 * planes (CORD-02/03/04): the control address of every held epoch with its sync
 * coverage, the verification projection (verified heads, suspended entities,
 * pending evidence, removal floors, Grant history), the folded state and every
 * edition chain — and to hand-craft + publish arbitrary control events to it,
 * bypassing the user's role/permission checks (see `ControlPublisher`). Editions
 * are echoed into the local `controlStore`/`state$` immediately, so the other
 * panels update live after a publish.
 *
 * FOR TESTING ONLY — every publish hits the community's real relays and cannot be
 * unsent.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { ChevronDown, Landmark, RefreshCw } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { CommunityState, ConcordCommunity, ConcordPlaneSyncCoverage, DecodedEvent, Rumor } from "@applesauce/concord";
import { CONTROL_KIND } from "@applesauce/concord/helpers";
import { useConcord } from "../../hooks/use-concord";
import { useCommunity } from "../../hooks/use-community";
import { decodePerms, tagVal, vskLabel } from "../../helpers/control-debug";
import { ControlPublisher } from "./ControlPublisher";
import { UserLabel } from "../User";
import { formatTime } from "../../helpers/util";
import { dateTime, deriveGenerationKeys, generationRows, shortHex, stringify } from "../../helpers/concord-history";
import { DebugSection as Section, DebugSideTabs, Expandable, Hex, JsonBlock, KV, UserList } from "./debug-ui";

// ---- current state panel ---------------------------------------------------

function StatePanel({ state }: { state: CommunityState }) {
  const roleName = (id: string) => state.roles.find((r) => r.role_id === id)?.name ?? shortHex(id);
  const roles = [...state.roles].sort((a, b) => a.position - b.position);
  const liveRoles = roles.filter((r) => !r.deleted).length;
  const privateChannels = state.channels.filter((c) => c.private).length;
  return (
    <div className="flex flex-col border border-base-300 rounded-box divide-y divide-base-300 overflow-hidden">
      <Expandable title="Community" summary={state.metadata?.name ?? state.material.name} open>
        <KV label="name"><strong>{state.metadata?.name ?? state.material.name}</strong></KV>
        {state.metadata?.description && <KV label="description">{state.metadata.description}</KV>}
        <KV label="community_id"><Hex value={state.material.community_id} full /></KV>
        <KV label="owner"><UserLabel pubkey={state.material.owner} /></KV>
        <KV label="counts">
          <span className="inline-flex flex-wrap gap-2">
            <span className="badge badge-outline">{state.members.size} members</span>
            <span className="badge badge-outline">{liveRoles} roles</span>
            <span className="badge badge-outline">{state.channels.length} channels</span>
            <span className="badge badge-outline">{state.banlist.size} banned</span>
            <span className="badge badge-outline">{state.inviteLinks.size} invite links</span>
          </span>
        </KV>
        <KV label="flags">
          <span className="inline-flex flex-wrap gap-2">
            {state.dissolved ? <span className="badge badge-error">dissolved</span> : <span className="badge badge-ghost">not dissolved</span>}
            {state.inviteLinks.size > 0 ? <span className="badge badge-info">public</span> : <span className="badge badge-ghost">private</span>}
            {state.pause?.paused && (
              <span className="badge badge-warning">
                paused since {dateTime(state.pause.since * 1000)}{state.pause.until !== undefined && ` until ${dateTime(state.pause.until * 1000)}`}
              </span>
            )}
          </span>
        </KV>
        {state.pause && <KV label="pause signal by"><UserLabel pubkey={state.pause.by} /></KV>}
      </Expandable>

      <Expandable title="Roles" summary={`${liveRoles} live${roles.length > liveRoles ? ` · ${roles.length - liveRoles} deleted` : ""}`}>
        {roles.length === 0 ? (
          <p className="opacity-60">No roles.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {roles.map((r) => (
              <div key={r.role_id} className={`flex items-baseline gap-2 flex-wrap ${r.deleted ? "opacity-50" : ""}`}>
                <span className="badge badge-sm" style={r.color ? { backgroundColor: `#${r.color.toString(16).padStart(6, "0")}`, color: "#fff", borderColor: "transparent" } : undefined}>
                  {r.name}
                </span>
                {r.deleted && <span className="badge badge-sm badge-error">deleted</span>}
                <span className="opacity-50">pos {r.position}</span>
                <span className="opacity-50">{r.scope.kind === "channel" ? `#${shortHex(r.scope.channel_id)}` : "server"}</span>
                <span className="opacity-70">{decodePerms(r.permissions).join(", ") || "no perms"}</span>
                <Hex value={r.role_id} />
              </div>
            ))}
          </div>
        )}
      </Expandable>

      <Expandable title="Channels" summary={`${state.channels.length} · ${privateChannels} private`}>
        {state.channels.length === 0 ? (
          <p className="opacity-60">No channels.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {state.channels.map((c) => (
              <div key={c.channel_id} className="flex flex-wrap items-baseline gap-2">
                <span>#{c.name}</span>
                <span className={`badge badge-xs ${c.private ? "badge-secondary" : "badge-ghost"}`}>{c.private ? "private" : "public"}</span>
                {c.deleted && <span className="badge badge-xs badge-error">deleted</span>}
                <Hex value={c.channel_id} />
              </div>
            ))}
          </div>
        )}
      </Expandable>

      <Expandable title="Grants" summary={`${state.grants.size} members`}>
        {state.grants.size === 0 ? (
          <p className="opacity-60">No grants.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {[...state.grants].map(([member, roleIds]) => (
              <div key={member} className="flex flex-wrap items-baseline gap-2">
                <UserLabel pubkey={member} />
                <span className="opacity-80">→ {roleIds.length ? roleIds.map(roleName).join(", ") : <span className="opacity-60">no roles</span>}</span>
              </div>
            ))}
          </div>
        )}
      </Expandable>

      <Expandable title="Members" summary={`${state.members.size}`}>
        <UserList pubkeys={state.members} empty="No members folded." />
      </Expandable>

      <Expandable title="Banlist" summary={`${state.banlist.size}`}>
        {state.banlist.size === 0 ? (
          <p className="opacity-60">Nobody banned.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {[...state.banlist].map((p) => (
              <div key={p} className="flex flex-wrap items-center gap-2">
                <UserLabel pubkey={p} />
                <Hex value={p} />
                {state.bannedAt?.get(p) !== undefined && <span className="opacity-60">since {dateTime(state.bannedAt.get(p)! * 1000)}</span>}
              </div>
            ))}
          </div>
        )}
      </Expandable>

      <Expandable title="Invite links" summary={`${state.inviteLinks.size} link signers`}>
        {state.inviteLinks.size === 0 ? (
          <p className="opacity-60">No live invite links.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {[...state.inviteLinks].map((k) => <Hex key={k} value={k} />)}
          </div>
        )}
      </Expandable>

      <Expandable title="Raw folded state" summary="secrets replaced by fingerprints">
        <JsonBlock json={stringify(state, true)} />
      </Expandable>
    </div>
  );
}

// ---- planes panel ----------------------------------------------------------

const COVERAGE_BADGE: Record<ConcordPlaneSyncCoverage["state"], string> = {
  syncing: "badge-warning",
  complete: "badge-success",
  incomplete: "badge-warning",
  error: "badge-error",
};

function relayStateClass(state: string): string {
  if (/complete|eose|done|ok/i.test(state)) return "text-success";
  if (/error|fail|closed|timeout/i.test(state)) return "text-error";
  return "text-warning";
}

function CoverageCell({ coverage }: { coverage: ConcordPlaneSyncCoverage | undefined }) {
  if (!coverage) return <span className="opacity-50">not read</span>;
  return (
    <div className="flex flex-col gap-1">
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className={`badge badge-sm ${COVERAGE_BADGE[coverage.state]}`}>{coverage.state}</span>
        <span className="badge badge-sm badge-ghost">{coverage.lane}</span>
      </span>
      {coverage.error !== undefined && (
        <span className="text-error break-all">{coverage.error instanceof Error ? coverage.error.message : String(coverage.error)}</span>
      )}
    </div>
  );
}

function RelayStates({ coverage }: { coverage: ConcordPlaneSyncCoverage | undefined }) {
  const entries = Object.entries(coverage?.relays ?? {});
  if (entries.length === 0) return <span className="opacity-50">—</span>;
  return (
    <div className="flex flex-col">
      {entries.map(([url, r]) => (
        <span key={url} className="font-mono whitespace-nowrap">
          <span className={relayStateClass(r.state)}>{r.state}</span> {url.replace(/^wss?:\/\//, "")}
        </span>
      ))}
    </div>
  );
}

/** Per-batch ingestion counts; newer Concord releases add them to plane coverage. */
type Ingestion = { arrivals: number; decoded: number; rejected: number; duplicate: number; routeRejected: number; routeFailed: number };

function IngestionCell({ coverage }: { coverage: ConcordPlaneSyncCoverage | undefined }) {
  const i = (coverage as { ingestion?: Ingestion } | undefined)?.ingestion;
  if (!i) return <span className="opacity-50">{coverage ? `${coverage.retained} routed` : "—"}</span>;
  const parts: [string, number, string?][] = [
    ["arrived", i.arrivals],
    ["decoded", i.decoded],
    ["dup", i.duplicate],
    ["rejected", i.rejected, "text-error"],
    ["route rejected", i.routeRejected, "text-warning"],
    ["route failed", i.routeFailed, "text-error"],
  ];
  return (
    <div className="flex flex-col whitespace-nowrap">
      {parts.map(([label, n, cls]) => (
        <span key={label} className={n > 0 && cls ? cls : n > 0 ? undefined : "opacity-50"}>
          {n} {label}
        </span>
      ))}
    </div>
  );
}

/** Every held epoch's control address, whether this device can write to it, and the sync coverage of its reads. */
function PlanesPanel({ community, state, rumors }: { community: ConcordCommunity; state: CommunityState; rumors: Rumor[] }) {
  const material = state.material;
  const coverage = use$(community.syncCoverage$);
  const relays = use$(community.relays$) ?? [];
  const rows = useMemo(() => generationRows(material), [material]);
  const keys = useMemo(() => deriveGenerationKeys(material), [material]);
  const cv = state.controlVerification;

  return (
    <div className="flex flex-col gap-6">
      <Section title="Overview" summary={`epoch ${material.root_epoch}`}>
        <KV label="mode">
          {material.control_pk ? "split" : "legacy"}
        </KV>
        <KV label="current address"><Hex value={keys[keys.length - 1]?.keys?.control.pk} full /></KV>
        <KV label="write capability">
          {keys[keys.length - 1]?.keys?.control.signing ? (
            <span className="badge badge-success">signing key held</span>
          ) : (
            <span className="badge badge-ghost">read only</span>
          )}
        </KV>
        <KV label="editions held">
          {rumors.length} control rumors · {state.heads?.size ?? 0} display heads · {cv?.heads.size ?? 0} verified heads
        </KV>
        <KV label="relays">
          <div className="flex flex-col">
            {relays.map((r) => <span key={r} className="font-mono">{r}</span>)}
          </div>
        </KV>
      </Section>

      <Section title="Control plane per epoch" summary={`${rows.length} held`}>
        <div className="overflow-x-auto">
          <table className="table text-base">
            <thead>
              <tr>
                <th>Epoch</th>
                <th>Address</th>
                <th>Write</th>
                <th>Coverage</th>
                <th>Relays</th>
                <th>Ingestion</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const k = keys[i];
                const addr = k?.keys?.control.pk;
                const c = addr ? coverage?.get(addr) : undefined;
                return (
                  <tr key={r.epoch} className={r.current ? "bg-base-200" : undefined}>
                    <td className="whitespace-nowrap align-top">
                      {r.epoch}
                      {r.current && <span className="badge badge-primary badge-sm ml-1">current</span>}
                      {r.controlPk ? <span className="badge badge-ghost badge-sm ml-1">split</span> : <span className="badge badge-ghost badge-sm ml-1">legacy</span>}
                    </td>
                    <td className="align-top">{k?.error ? <span className="text-error">Derivation failed: {k.error}</span> : <Hex value={addr} />}</td>
                    <td className="align-top">
                      {k?.keys?.control.signing ? <span className="badge badge-success badge-sm">sign</span> : <span className="badge badge-ghost badge-sm">read</span>}
                    </td>
                    <td className="align-top"><CoverageCell coverage={c} /></td>
                    <td className="align-top"><RelayStates coverage={c} /></td>
                    <td className="align-top"><IngestionCell coverage={c} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>
    </div>
  );
}

// ---- verification panel ----------------------------------------------------

type HeadLike = { edition: DecodedEvent; vsk: number; eid: string; version: number | string; hash: string; prevHash?: string };

/** The read epoch a restricted-writer edition was decoded under, when the Concord release records it. */
const readEpoch = (d: DecodedEvent) => (d as { readSource?: { epoch: number } }).readSource?.epoch;

function HeadsTable({ heads, empty }: { heads: HeadLike[]; empty: string }) {
  if (heads.length === 0) return <p className="opacity-60">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table text-base">
        <thead>
          <tr>
            <th>Entity</th>
            <th>eid</th>
            <th>ev</th>
            <th>Hash</th>
            <th>Prev</th>
            <th>Author</th>
            <th>Seal</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
          {heads.map((h) => (
            <tr key={`${h.eid}:${h.hash}`}>
              <td className="whitespace-nowrap">{vskLabel(h.vsk)}</td>
              <td><Hex value={h.eid} /></td>
              <td>{String(h.version)}</td>
              <td><Hex value={h.hash} /></td>
              <td><Hex value={h.prevHash} /></td>
              <td><UserLabel pubkey={h.edition.author} /></td>
              <td className="whitespace-nowrap">{h.edition.sealKind}{readEpoch(h.edition) !== undefined && <span className="opacity-60"> · read ep {readEpoch(h.edition)}</span>}</td>
              <td className="whitespace-nowrap">{dateTime(h.edition.ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const sortHeads = (heads: Iterable<HeadLike>) => [...heads].sort((a, b) => a.vsk - b.vsk || a.eid.localeCompare(b.eid));

/** The verified control projection: what grants enforcement authority, what is parked and why. */
function VerificationPanel({ state }: { state: CommunityState }) {
  const cv = state.controlVerification;
  const roleName = (id: string) => state.roles.find((r) => r.role_id === id)?.name ?? shortHex(id);
  if (!cv) return <p className="opacity-60">No verification projection yet.</p>;

  const displayOnly = [...(state.heads ?? [])].filter(([eid]) => !cv.heads.has(eid));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap gap-2">
        <span className="badge badge-success badge-outline">{cv.heads.size} verified heads</span>
        <span className={`badge ${cv.suspended.size ? "badge-warning" : "badge-ghost"}`}>{cv.suspended.size} suspended</span>
        <span className={`badge ${cv.pending.length ? "badge-warning" : "badge-ghost"}`}>{cv.pending.length} pending evidence</span>
        <span className="badge badge-ghost">{cv.removals.size} removal floors</span>
        <span className="badge badge-ghost">{cv.grantHistory.size} grant histories</span>
        <span className={`badge ${displayOnly.length ? "badge-warning" : "badge-ghost"}`}>{displayOnly.length} display-only heads</span>
      </div>

      <Section title="Pending evidence" summary={`${cv.pending.length}`}>
        {cv.pending.length === 0 ? (
          <p className="opacity-60">Nothing parked.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="table text-base">
              <thead>
                <tr>
                  <th>Reason</th>
                  <th>eid</th>
                  <th>ev</th>
                  <th>Hash</th>
                  <th>Actor</th>
                </tr>
              </thead>
              <tbody>
                {cv.pending.map((p, i) => (
                  <tr key={i}>
                    <td><span className="badge badge-warning badge-sm whitespace-nowrap">{p.reason}</span></td>
                    <td><Hex value={p.eid} /></td>
                    <td>{p.version !== undefined ? String(p.version) : "—"}</td>
                    <td><Hex value={p.hash} /></td>
                    <td>{p.actor ? <UserLabel pubkey={p.actor} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Suspended entities" summary={`${cv.suspended.size}`}>
        {cv.suspended.size === 0 ? (
          <p className="opacity-60">None.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {[...cv.suspended].map((eid) => {
              const head = state.heads?.get(eid);
              return (
                <div key={eid} className="flex flex-wrap items-center gap-2">
                  <span className="badge badge-warning badge-sm">{head ? vskLabel(tagVal(head.rumor, "vsk")) : "unknown"}</span>
                  <Hex value={eid} />
                  {head && <span className="opacity-60">display head v{tagVal(head.rumor, "ev") ?? "?"} by <UserLabel pubkey={head.author} /></span>}
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {displayOnly.length > 0 && (
        <Section title="Display-only heads" summary={`${displayOnly.length}`}>
          <div className="flex flex-col gap-1">
            {displayOnly.map(([eid, d]) => (
              <div key={eid} className="flex flex-wrap items-center gap-2">
                <span className="badge badge-ghost badge-sm">{vskLabel(tagVal(d.rumor, "vsk"))}</span>
                <Hex value={eid} />
                <span className="opacity-60">v{tagVal(d.rumor, "ev") ?? "?"} by</span>
                <UserLabel pubkey={d.author} />
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Verified heads" summary={`${cv.heads.size}`}>
        <HeadsTable heads={sortHeads(cv.heads.values())} empty="No verified heads." />
      </Section>

      <Section title="Removal floors" summary={`${cv.removals.size}`}>
        <HeadsTable heads={sortHeads(cv.removals.values())} empty="No removals." />
      </Section>

      <Section title="Grant history" summary={`${cv.grantHistory.size}`}>
        {cv.grantHistory.size === 0 ? (
          <p className="opacity-60">No grants.</p>
        ) : (
          <div className="flex flex-col gap-3">
            {[...cv.grantHistory].map(([coord, editions]) => (
              <div key={coord} className="flex flex-col gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  {editions[0] && <UserLabel pubkey={editions[0].member} />}
                  <Hex value={coord} />
                  <span className="opacity-60">{editions.length} editions</span>
                </div>
                <div className="pl-4 flex flex-col gap-0.5">
                  {editions.map((g) => (
                    <div key={g.hash} className="flex flex-wrap items-center gap-2">
                      <span className="badge badge-outline badge-sm">v{String(g.version)}</span>
                      <span>{g.roleIds.length ? g.roleIds.map(roleName).join(", ") : <span className="opacity-60">no roles</span>}</span>
                      <span className="opacity-60">by</span>
                      <UserLabel pubkey={g.edition.author} />
                      <span className="opacity-50 whitespace-nowrap">{dateTime(g.edition.ms)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ---- editions panel --------------------------------------------------------

type EntityChain = { key: string; vsk: string; eid: string; editions: Rumor[] };

/** Group the raw control rumors into per-entity edition chains, ordered by `ev`. */
function groupChains(rumors: Rumor[]): EntityChain[] {
  const map = new Map<string, EntityChain>();
  for (const r of rumors) {
    const vsk = tagVal(r, "vsk") ?? "?";
    const eid = tagVal(r, "eid") ?? "?";
    const key = `${vsk}:${eid}`;
    if (!map.has(key)) map.set(key, { key, vsk, eid, editions: [] });
    map.get(key)!.editions.push(r);
  }
  for (const chain of map.values()) {
    chain.editions.sort((a, b) => Number(tagVal(a, "ev") ?? 0) - Number(tagVal(b, "ev") ?? 0));
  }
  return [...map.values()].sort((a, b) => Number(a.vsk) - Number(b.vsk) || a.eid.localeCompare(b.eid));
}

type EditionStatus = { displayed: boolean; verified: boolean; removal: boolean };

function EditionRow({ rumor, status }: { rumor: Rumor; status: EditionStatus }) {
  const [open, setOpen] = useState(false);
  const ev = tagVal(rumor, "ev");
  const ep = tagVal(rumor, "ep");
  const vac = rumor.tags.find((t) => t[0] === "vac");
  const applied = status.displayed || status.verified;
  return (
    <div className="border-t border-base-300 first:border-t-0 py-1.5">
      <button className="w-full flex items-center gap-2 text-left" onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="badge badge-xs badge-outline shrink-0">v{ev ?? "?"}</span>
        {status.verified && <span className="badge badge-xs badge-success shrink-0">verified</span>}
        {status.displayed && !status.verified && <span className="badge badge-xs badge-warning shrink-0" title="Displayed, but not a verified head">displayed</span>}
        {status.removal && <span className="badge badge-xs badge-error shrink-0">removal floor</span>}
        {!applied && !status.removal && (
          <span className="badge badge-xs badge-ghost shrink-0" title="Superseded or rejected">not applied</span>
        )}
        <UserLabel pubkey={rumor.pubkey} className="shrink-0" />
        <span className="opacity-40 truncate flex-1">{rumor.content || "(empty)"}</span>
        <span className="opacity-40 shrink-0 max-sm:hidden">{formatTime(rumor.created_at * 1000)}</span>
      </button>
      {open && (
        <div className="pl-6 pt-1 flex flex-col gap-1">
          <div className="opacity-60">rumor <Hex value={rumor.id} /></div>
          {ep && <div className="opacity-60">ep <Hex value={ep} /></div>}
          {vac && <div className="opacity-60">vac [{vac.slice(1).map(shortHex).join(", ")}]</div>}
          <JsonBlock json={stringify(rumor)} maxHeight="max-h-[40vh]" />
        </div>
      )}
    </div>
  );
}

function EditionsPanel({ rumors, state, initialQuery = "" }: { rumors: Rumor[]; state: CommunityState; initialQuery?: string }) {
  const [vskFilter, setVskFilter] = useState("all");
  const [query, setQuery] = useState(initialQuery);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const chains = useMemo(() => groupChains(rumors), [rumors]);
  const cv = state.controlVerification;
  const ids = useMemo(() => {
    const displayed = new Set<string>();
    state.heads?.forEach((d) => displayed.add(d.rumor.id));
    const verified = new Set<string>();
    cv?.heads.forEach((h) => verified.add(h.edition.rumor.id));
    const removal = new Set<string>();
    cv?.removals.forEach((h) => removal.add(h.edition.rumor.id));
    return { displayed, verified, removal };
  }, [state.heads, cv]);
  const pendingEids = useMemo(() => new Set(cv?.pending.map((p) => p.eid)), [cv]);

  const q = query.trim().toLowerCase();
  const visible = chains.filter((c) => {
    if (vskFilter !== "all" && c.vsk !== vskFilter) return false;
    if (problemsOnly && !cv?.suspended.has(c.eid) && !pendingEids.has(c.eid)) return false;
    if (!q) return true;
    return c.eid.toLowerCase().includes(q) || c.editions.some((r) => r.pubkey.includes(q) || r.id.includes(q) || r.content.toLowerCase().includes(q));
  });
  const vsks = [...new Set(chains.map((c) => c.vsk))];

  if (chains.length === 0) return <p className="opacity-60">No editions loaded.</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="opacity-60">{rumors.length} editions · {chains.length} entities</p>
      <div className="flex flex-wrap items-center gap-2">
        <select className="select select-bordered select-sm w-auto" value={vskFilter} onChange={(e) => setVskFilter(e.target.value)}>
          <option value="all">All entities</option>
          {vsks.map((v) => <option key={v} value={v}>{vskLabel(v)} ({v})</option>)}
        </select>
        <input
          className="input input-bordered input-sm flex-1 min-w-48 font-mono"
          placeholder="Filter by eid, author, rumor id or content"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" className="checkbox checkbox-sm" checked={problemsOnly} onChange={(e) => setProblemsOnly(e.target.checked)} />
          suspended / pending only
        </label>
      </div>
      {visible.length === 0 && <p className="opacity-60">No entities match.</p>}
      {visible.map((chain) => (
        <div key={chain.key} className="border border-base-300 rounded-box p-3">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <span className="badge badge-sm badge-primary">{vskLabel(chain.vsk)}</span>
            <Hex value={chain.eid} />
            <span className="opacity-40">{chain.editions.length} editions</span>
            {cv?.suspended.has(chain.eid) && <span className="badge badge-sm badge-warning">suspended</span>}
            {pendingEids.has(chain.eid) && <span className="badge badge-sm badge-warning">pending evidence</span>}
          </div>
          {chain.editions.map((r) => (
            <EditionRow
              key={r.id}
              rumor={r}
              status={{ displayed: ids.displayed.has(r.id), verified: ids.verified.has(r.id), removal: ids.removal.has(r.id) }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---- shell -----------------------------------------------------------------

type Tab = "planes" | "verification" | "editions" | "state" | "publish";

/** The full control-plane view of one community, in horizontal sub-tabs. */
export function ControlPlaneInspector({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const account = useActiveAccount();
  // Material is replaced wholesale on adoption; epoch$ re-renders the per-epoch planes.
  use$(() => community?.epoch$, [community]);
  const state = use$(() => community?.state$, [community]) as CommunityState | undefined;
  const rumors = (use$(() => community?.controlStore.timeline([{ kinds: [CONTROL_KIND] }]), [community]) as Rumor[] | undefined) ?? [];
  const [tab, setTab] = useState<Tab>("planes");
  const [editionsQuery, setEditionsQuery] = useState("");

  if (!community || !state || !account) return <p className="opacity-70">Loading community…</p>;
  const cv = state.controlVerification;
  const problems = (cv?.suspended.size ?? 0) + (cv?.pending.length ?? 0);
  const tabs: { id: Tab; label: ReactNode }[] = [
    { id: "planes", label: "Planes" },
    {
      id: "verification",
      label: <>Verification{problems > 0 && <span className="badge badge-warning badge-xs">{problems}</span>}</>,
    },
    { id: "editions", label: <>Editions <span className="badge badge-ghost badge-xs">{rumors.length}</span></> },
    { id: "state", label: "Folded state" },
    { id: "publish", label: "Publish" },
  ];

  return (
    <div className="flex gap-6 max-md:flex-col max-md:gap-4">
      <DebugSideTabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="flex-1 min-w-0 flex flex-col gap-4">
        {tab === "planes" && <PlanesPanel community={community} state={state} rumors={rumors} />}
        {tab === "verification" && <VerificationPanel state={state} />}
        {tab === "editions" && <EditionsPanel key={editionsQuery} rumors={rumors} state={state} initialQuery={editionsQuery} />}
        {tab === "state" && <StatePanel state={state} />}
        {tab === "publish" && (
          <ControlPublisher
            community={community}
            state={state}
            self={account.pubkey}
            rumors={rumors}
            onShowEditions={(eid) => {
              setEditionsQuery(eid);
              setTab("editions");
            }}
          />
        )}
      </div>
    </div>
  );
}

export function ControlPlaneDebugger() {
  const client = useConcord();
  const communities = use$(client.communities$) ?? [];
  const [cid, setCid] = useState<string | null>(null);

  return (
    <>
      <p className="opacity-70 leading-relaxed mb-5">
        Inspect a community's control plane and publish arbitrary control events, bypassing permission checks.
      </p>

      <div className="mb-5">
        <label className="font-semibold uppercase opacity-70">Community</label>
        <div className="flex items-center gap-2 mt-1">
          <select
            className="select select-bordered min-w-64"
            value={cid ?? ""}
            onChange={(e) => setCid(e.target.value || null)}
          >
            <option value="" disabled>Select a community…</option>
            {communities.map((c) => (
              <option key={c.material.community_id} value={c.material.community_id}>
                {c.metadata?.name ?? c.material.name ?? "Community"}
              </option>
            ))}
          </select>
          {cid && (
            <button className="btn btn-ghost gap-1" onClick={() => setCid(null)} title="Pick another community">
              <RefreshCw size={14} /> change
            </button>
          )}
        </div>
      </div>

      {cid ? (
        <ControlPlaneInspector key={cid} cid={cid} />
      ) : communities.length === 0 ? (
        <div className="flex flex-col items-center gap-2 opacity-60 py-16 text-center">
          <Landmark size={40} />
          <p>No communities.</p>
        </div>
      ) : (
        <p className="opacity-60">Pick a community.</p>
      )}
    </>
  );
}
