/**
 * Community Debug — a developer-mode tab in community settings showing one
 * community's technical state: sync status, the root generations this device
 * holds (with rotation dates and refounders), an on-demand per-relay audit of
 * every held epoch's planes and the CORD-06 rotations between them, current and
 * per-epoch membership, private channel key epochs, live rotation diagnostics and
 * the (redacted) raw material. Read-only: nothing here publishes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import type { ConcordDiagnostic, JoinMaterial, RotationDiagnostic } from "@applesauce/concord";
import { deriveConcordKeys, verifyOwner, type ConcordKeys } from "@applesauce/concord/helpers";
import { Check, Copy, RefreshCw } from "lucide-react";
import { pool } from "../../nostr";
import { useConcord } from "../../hooks/use-concord";
import { useCommunity } from "../../hooks/use-community";
import { UserLabel } from "../User";
import {
  AUDIT_PLANES,
  auditEpoch,
  buildChain,
  diffMembers,
  fingerprint,
  generationRows,
  relaysFor,
  shortHex,
  stringify,
  type AuditPlane,
  type EpochAudit,
  type RotationAudit,
} from "../../helpers/concord-history";

const NO_SET: ReadonlySet<string> = new Set();
const NO_GRANTS: ReadonlyMap<string, string[]> = new Map();

/** A rotation's relay date and the local `retired_at` may differ by publish latency; flag beyond this. */
const DATE_SKEW_WARN_MS = 5 * 60_000;

function dateTime(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}

function Card({ title, summary, open, children }: { title: string; summary?: ReactNode; open?: boolean; children: ReactNode }) {
  return (
    <details className="border border-base-300 rounded-box mb-3 group" open={open}>
      <summary className="cursor-pointer px-4 py-3 flex items-center gap-3 select-none">
        <span className="font-bold uppercase tracking-wide text-sm opacity-70">{title}</span>
        {summary && <span className="text-sm opacity-70 truncate">{summary}</span>}
      </summary>
      <div className="px-4 pb-4 flex flex-col gap-3 text-sm">{children}</div>
    </details>
  );
}

function KV({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 min-w-0">
      <span className="w-40 shrink-0 opacity-60">{label}</span>
      <span className="min-w-0 break-all">{children}</span>
    </div>
  );
}

function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <code className="font-mono text-xs opacity-80" title={title}>
      {children}
    </code>
  );
}

function UserList({ pubkeys, empty = "None." }: { pubkeys: Iterable<string>; empty?: string }) {
  const list = [...pubkeys];
  if (list.length === 0) return <p className="opacity-60">{empty}</p>;
  return (
    <div className="flex flex-col gap-1">
      {list.map((p) => (
        <div key={p} className="flex items-center gap-2">
          <UserLabel pubkey={p} />
          <Mono title={p}>{shortHex(p)}</Mono>
        </div>
      ))}
    </div>
  );
}

// ---- status ----------------------------------------------------------------

function StatusCard({ cid }: { cid: string }) {
  const client = useConcord();
  const community = useCommunity(cid);
  const status = use$(() => community?.status$, [community]);
  const memberships = use$(() => client.memberships$, [client]);
  const metadata = use$(() => community?.metadata$, [community]);
  if (!community) return null;
  const material = community.material;
  const entry = memberships?.entries.find((e) => e.community_id === cid);
  const relays = [...new Set([...material.relays, ...(metadata?.relays ?? [])])];
  const phaseBadge = status?.phase === "live" ? "badge-success" : status?.phase === "error" || status?.phase === "removed" ? "badge-error" : "badge-warning";

  return (
    <Card
      title="Status"
      open
      summary={
        <>
          <span className={`badge badge-sm ${phaseBadge}`}>{status?.phase ?? "…"}</span> epoch {status?.epoch ?? material.root_epoch}
        </>
      }
    >
      <KV label="phase">
        <span className={`badge badge-sm ${phaseBadge}`}>{status?.phase ?? "…"}</span>{" "}
        <span className={`badge badge-sm ${status?.connected ? "badge-success" : "badge-ghost"}`}>{status?.connected ? "connected" : "disconnected"}</span>
      </KV>
      {status?.error && <KV label="last error"><span className="text-error">{status.error}</span></KV>}
      <KV label="community_id"><Mono>{cid}</Mono></KV>
      <KV label="owner">
        <span className="inline-flex items-center gap-2">
          <UserLabel pubkey={material.owner} />
          {verifyOwner(material) ? <span className="badge badge-sm badge-success">proof ok</span> : <span className="badge badge-sm badge-error">proof failed</span>}
        </span>
      </KV>
      <KV label="root epoch">{material.root_epoch}</KV>
      <KV label="refounder">{material.refounder ? <UserLabel pubkey={material.refounder} /> : <span className="opacity-60">— (genesis)</span>}</KV>
      <KV label="material rev">{material.rev ?? 0}</KV>
      <KV label="control">
        {material.control_pk ? (
          <>
            split · <Mono>{shortHex(material.control_pk)}</Mono>{" "}
            {material.control_root ? <span className="badge badge-sm badge-success">signing root held</span> : <span className="badge badge-sm badge-ghost">read only</span>}
          </>
        ) : (
          "legacy (derived from root)"
        )}
      </KV>
      <KV label="relays">
        <div className="flex flex-col">
          {relays.map((r) => (
            <span key={r} className="font-mono text-xs">
              {r}
              {!material.relays.includes(r) && <span className="badge badge-xs badge-ghost ml-2">metadata only</span>}
            </span>
          ))}
        </div>
      </KV>
      <div className="border-t border-base-300 pt-3 flex flex-col gap-1.5">
        <span className="font-semibold opacity-70">Community List</span>
        {entry ? (
          <>
            <KV label="seed epoch">{entry.seed.root_epoch}</KV>
            <KV label="listed current epoch">
              {entry.current.root_epoch}
              {entry.current.root_epoch !== material.root_epoch && <span className="badge badge-sm badge-warning ml-2">differs from engine ({material.root_epoch})</span>}
            </KV>
            <KV label="added">{dateTime(entry.added_at)}</KV>
          </>
        ) : (
          <p className="text-warning">No Community List entry for this community.</p>
        )}
        <KV label="list state">
          {memberships?.knowledge ?? "…"}
          {memberships?.pending && <span className="badge badge-sm badge-warning ml-2">save pending</span>}
          {memberships?.locked && <span className="badge badge-sm badge-warning ml-2">fragment locked</span>}
        </KV>
      </div>
    </Card>
  );
}

// ---- generations -----------------------------------------------------------

function GenerationsCard({ material, keys }: { material: JoinMaterial; keys: ConcordKeys[] }) {
  const rows = useMemo(() => generationRows(material), [material]);
  const first = rows[0]?.epoch ?? material.root_epoch;
  const problems = rows.filter((r) => r.gapBefore || (!r.current && r.retiredAt === undefined)).length;
  return (
    <Card
      title="Generations"
      open
      summary={
        <>
          {rows.length} held (epoch {first} → {material.root_epoch})
          {problems > 0 && <span className="badge badge-sm badge-warning ml-2">{problems} flagged</span>}
        </>
      }
    >
      <p className="opacity-70">
        Root epochs this device holds keys for, from local material (<code>held_roots</code> + current). Root keys are shown as sha256
        fingerprints so devices can be compared without exposing them.
      </p>
      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr>
              <th>Epoch</th>
              <th>Root fp</th>
              <th>Refounder</th>
              <th>Active from</th>
              <th>Retired</th>
              <th>Control</th>
              <th>Guestbook</th>
              <th>Next rekey</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.epoch} className={r.current ? "bg-base-200" : undefined}>
                <td className="whitespace-nowrap">
                  {r.epoch}
                  {r.current && <span className="badge badge-xs badge-primary ml-1">current</span>}
                  {r.gapBefore && <span className="badge badge-xs badge-warning ml-1" title="The epoch before this one is not held">gap</span>}
                </td>
                <td><Mono>{r.rootFingerprint}</Mono></td>
                <td>{r.refounder ? <UserLabel pubkey={r.refounder} /> : <span className="opacity-60">{r.epoch === 0 ? "genesis" : "unknown"}</span>}</td>
                <td className="whitespace-nowrap">{r.epoch === first && r.activeFrom === undefined ? "—" : dateTime(r.activeFrom && r.activeFrom * 1000)}</td>
                <td className="whitespace-nowrap">
                  {r.current ? <span className="opacity-60">current</span> : r.retiredAt !== undefined ? dateTime(r.retiredAt * 1000) : <span className="text-warning">missing retired_at</span>}
                </td>
                <td><Mono title={keys[i]?.control.pk}>{shortHex(keys[i]?.control.pk)}</Mono></td>
                <td><Mono title={keys[i]?.guestbook.pk}>{shortHex(keys[i]?.guestbook.pk)}</Mono></td>
                <td><Mono title={keys[i]?.nextBaseRekey.key.pk}>{shortHex(keys[i]?.nextBaseRekey.key.pk)}</Mono></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ---- relay audit -----------------------------------------------------------

const PLANE_LABEL: Record<AuditPlane, string> = { control: "control", guestbook: "guestbook", rekey: "rekey →" };

function PresenceMatrix({ audits, relays }: { audits: EpochAudit[]; relays: string[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="table table-xs">
        <thead>
          <tr>
            <th>Epoch</th>
            <th>Plane</th>
            <th>Address</th>
            {relays.map((r) => (
              <th key={r} className="font-mono normal-case" title={r}>{r.replace(/^wss?:\/\//, "")}</th>
            ))}
            <th>Decoded</th>
          </tr>
        </thead>
        <tbody>
          {audits.flatMap((a) =>
            AUDIT_PLANES.map((plane, pi) => (
              <tr key={`${a.epoch}:${plane}`} className={pi === 0 ? "border-t-2 border-base-300" : undefined}>
                <td>{pi === 0 ? a.epoch : ""}</td>
                <td className="whitespace-nowrap">{plane === "rekey" ? `rekey → ${a.epoch + 1}` : PLANE_LABEL[plane]}</td>
                <td><Mono title={a.addresses[plane]}>{shortHex(a.addresses[plane])}</Mono></td>
                {relays.map((r) => {
                  const res = a.relays.get(r);
                  if (!res) return <td key={r}>—</td>;
                  if (!res.ok) return <td key={r} className="text-error" title={res.error}>err</td>;
                  const n = res.counts[plane];
                  // An empty rekey address at the tip is the normal case, not a loss.
                  const expected = plane !== "rekey" || a.rotations.length > 0;
                  return (
                    <td key={r} className={n > 0 ? "text-success font-semibold" : expected ? "text-error font-semibold" : "opacity-50"}>{n}</td>
                  );
                })}
                <td>{a.totals[plane]}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function RotationCard({ rotation, relays, retiredAt, isTip }: { rotation: RotationAudit; relays: string[]; retiredAt?: number; isTip: boolean }) {
  const skew = retiredAt !== undefined ? Math.abs(retiredAt * 1000 - rotation.firstMs) : undefined;
  return (
    <div className={`border rounded-box p-3 flex flex-col gap-2 ${rotation.complete && rotation.consistent ? "border-base-300" : "border-error"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Epoch {rotation.prevEpoch} → {rotation.newEpoch}</span>
        {rotation.complete ? <span className="badge badge-sm badge-success">complete</span> : <span className="badge badge-sm badge-error">incomplete</span>}
        {rotation.consistent ? <span className="badge badge-sm badge-success badge-outline">consistent</span> : <span className="badge badge-sm badge-error">inconsistent: {rotation.inconsistencies.join(", ")}</span>}
        {isTip && <span className="badge badge-sm badge-warning">not adopted by this device</span>}
        <Mono title={rotation.candidateId}>{shortHex(rotation.candidateId)}</Mono>
      </div>
      <KV label="rotator"><UserLabel pubkey={rotation.rotator} />{rotation.vac ? <span className="opacity-60 ml-2">via grant {shortHex(rotation.vac[0])} v{rotation.vac[1]}</span> : <span className="opacity-60 ml-2">(owner, no vac)</span>}</KV>
      <KV label="published (relay)">
        {dateTime(rotation.firstMs)}
        {skew !== undefined && skew > DATE_SKEW_WARN_MS && <span className="badge badge-sm badge-warning ml-2">local retired_at {dateTime(retiredAt! * 1000)}</span>}
      </KV>
      <KV label="chunks">
        {rotation.chunksHeld.length} / {rotation.chunkCount}
        {rotation.missingIndexes.length > 0 && <span className="text-error ml-2">missing #{rotation.missingIndexes.join(", #")}</span>}
      </KV>
      <KV label="per relay">
        <div className="flex flex-col">
          {relays.map((r) => {
            const held = rotation.chunksByRelay.get(r) ?? [];
            const full = held.length === rotation.chunkCount;
            return (
              <span key={r} className="font-mono text-xs">
                <span className={full ? "text-success" : held.length ? "text-warning" : "text-error"}>{held.length}/{rotation.chunkCount}</span> {r}
              </span>
            );
          })}
        </div>
      </KV>
      <KV label="recipients">
        {rotation.blobCount} blobs · {rotation.rekeyed.length} of {rotation.rekeyed.length + rotation.notRekeyed.length} epoch-{rotation.prevEpoch} members rekeyed
      </KV>
      {rotation.notRekeyed.length > 0 && (
        <details>
          <summary className="cursor-pointer text-warning">{rotation.notRekeyed.length} members not rekeyed (removed, or missed)</summary>
          <div className="pt-2"><UserList pubkeys={rotation.notRekeyed} /></div>
        </details>
      )}
    </div>
  );
}

function MembersByEpoch({ audits }: { audits: EpochAudit[] }) {
  return (
    <div className="flex flex-col gap-1">
      {audits.map((a, i) => {
        const { added, removed } = diffMembers(i > 0 ? audits[i - 1].state.members : undefined, a.state.members);
        return (
          <details key={a.epoch} className="border border-base-300 rounded-box px-3 py-2">
            <summary className="cursor-pointer flex flex-wrap items-center gap-2">
              <span className="font-semibold">Epoch {a.epoch}</span>
              <span className="badge badge-sm badge-ghost">{a.state.members.size} members</span>
              {added.length > 0 && <span className="badge badge-sm badge-success badge-outline">+{added.length}</span>}
              {removed.length > 0 && <span className="badge badge-sm badge-error badge-outline">−{removed.length}</span>}
              {a.state.banlist.size > 0 && <span className="badge badge-sm badge-ghost">{a.state.banlist.size} banned</span>}
            </summary>
            <div className="pt-2 grid gap-3 md:grid-cols-2">
              <div>
                <p className="opacity-60 mb-1">Members</p>
                <UserList pubkeys={a.state.members} />
              </div>
              <div className="flex flex-col gap-2">
                {added.length > 0 && <div><p className="text-success mb-1">Added since previous epoch</p><UserList pubkeys={added} /></div>}
                {removed.length > 0 && <div><p className="text-error mb-1">Removed since previous epoch</p><UserList pubkeys={removed} /></div>}
              </div>
            </div>
          </details>
        );
      })}
    </div>
  );
}

function RelayAuditCard({ material, relays }: { material: JoinMaterial; relays: string[] }) {
  const [audits, setAudits] = useState<EpochAudit[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    setAudits([]);
    const chain = buildChain(material);
    const out: EpochAudit[] = [];
    try {
      for (const m of chain) {
        if (!alive.current) return;
        setProgress(`Auditing epoch ${m.root_epoch} (${out.length + 1}/${chain.length})…`);
        out.push(await auditEpoch(pool, m, out[out.length - 1]?.keys, relays));
        if (alive.current) setAudits([...out]);
      }
      if (alive.current) setCheckedAt(Date.now());
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (alive.current) {
        setBusy(false);
        setProgress("");
      }
    }
  }

  const retired = new Map((material.held_roots ?? []).map((r) => [r.epoch, r.retired_at]));
  const missingTransitions = audits.filter((a) => a.epoch !== material.root_epoch && a.rotations.length === 0);
  const tip = audits.find((a) => a.epoch === material.root_epoch);

  return (
    <Card
      title="Relay audit"
      open
      summary={checkedAt ? `checked ${dateTime(checkedAt)}` : "not run"}
    >
      <p className="opacity-70">
        Fetches each held epoch's control, guestbook and next-epoch rekey addresses from every community relay separately, then checks
        each rotation for completeness and which members it delivered a key to. Members per epoch are folded from the Guestbook and
        control authors only (channel activity is not fetched).
      </p>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary btn-sm gap-1.5" disabled={busy} onClick={() => void run()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}
          {audits.length ? "Re-check relays" : "Check relays"}
        </button>
        {progress && <span className="opacity-70">{progress}</span>}
      </div>
      {error && <div className="alert alert-error py-2">{error}</div>}
      {audits.length > 0 && (
        <>
          <PresenceMatrix audits={audits} relays={relays} />
          {audits.some((a) => a.undecodable > 0) && (
            <p className="text-warning">
              {audits.reduce((n, a) => n + a.undecodable, 0)} wraps at these addresses did not decode under the held keys.
            </p>
          )}

          <h4 className="font-semibold mt-2">Rotations</h4>
          {missingTransitions.map((a) => (
            <div key={a.epoch} className="alert alert-error py-2">
              No rekey events for epoch {a.epoch} → {a.epoch + 1} found on any relay. The rotation's evidence is gone (or was never published here).
            </div>
          ))}
          {tip && tip.rotations.length > 0 && (
            <div className="alert alert-warning py-2">
              Rekey events exist at the current epoch's next address — a rotation to epoch {tip.epoch + 1} this device has not adopted.
              Check the diagnostics below for a parked or rejected candidate.
            </div>
          )}
          {audits.flatMap((a) =>
            a.rotations.map((r) => (
              <RotationCard
                key={r.candidateId}
                rotation={r}
                relays={relays}
                retiredAt={retired.get(a.epoch)}
                isTip={a.epoch === material.root_epoch}
              />
            )),
          )}
          {audits.some((a) => a.rotations.length > 1) && (
            <p className="text-warning">Several candidates for one transition: concurrent rotators raced (lowest key wins).</p>
          )}
          {audits.flatMap((a) => a.malformed.map((m) => ({ ...m, epoch: a.epoch }))).map((m) => (
            <p key={m.wrapId} className="text-error">
              Epoch {m.epoch}: malformed rekey <Mono>{shortHex(m.wrapId)}</Mono> ({m.reason})
            </p>
          ))}
          {audits.length > 0 && audits.every((a) => a.rotations.length === 0) && audits.length === 1 && (
            <p className="opacity-60">No rotations: this community has a single generation.</p>
          )}

          <h4 className="font-semibold mt-2">Members by epoch</h4>
          <MembersByEpoch audits={audits} />
        </>
      )}
    </Card>
  );
}

// ---- membership / channels -------------------------------------------------

function MembershipCard({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const members = use$(() => community?.members$, [community]) ?? NO_SET;
  const banlist = use$(() => community?.banlist$, [community]) ?? NO_SET;
  const grants = use$(() => community?.grants$, [community]) ?? NO_GRANTS;
  const roles = use$(() => community?.roles$, [community]);
  const roleName = (id: string) => roles?.find((r) => r.role_id === id)?.name ?? shortHex(id);
  return (
    <Card title="Current membership" summary={`${members.size} members · ${grants.size} grants · ${banlist.size} banned`}>
      <div className="flex flex-col gap-1">
        {[...members].map((m) => (
          <div key={m} className="flex flex-wrap items-center gap-2">
            <UserLabel pubkey={m} />
            <Mono title={m}>{shortHex(m)}</Mono>
            {(grants.get(m) ?? []).map((id) => (
              <span key={id} className="badge badge-sm badge-outline">{roleName(id)}</span>
            ))}
          </div>
        ))}
      </div>
      {banlist.size > 0 && (
        <div className="border-t border-base-300 pt-3">
          <p className="font-semibold opacity-70 mb-1">Banlist</p>
          <UserList pubkeys={banlist} />
        </div>
      )}
    </Card>
  );
}

function ChannelsCard({ cid, material }: { cid: string; material: JoinMaterial }) {
  const community = useCommunity(cid);
  const views = use$(() => community?.channelViews$, [community]);
  const privateViews = (views ?? []).filter((v) => v.private);
  const keyed = new Map(material.channels.map((c) => [c.id, c]));
  return (
    <Card
      title="Private channels"
      summary={`${material.channels.length} keyed · ${privateViews.filter((v) => !keyed.has(v.channel_id)).length} without key · ${material.unheld_channels?.length ?? 0} unheld list entries`}
    >
      {privateViews.length === 0 && material.channels.length === 0 ? (
        <p className="opacity-60">No private channels.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead>
              <tr>
                <th>Channel</th>
                <th>Id</th>
                <th>Access</th>
                <th>Key epoch</th>
                <th>Key fp</th>
                <th>Held prior keys</th>
              </tr>
            </thead>
            <tbody>
              {[...new Set([...privateViews.map((v) => v.channel_id), ...keyed.keys()])].map((id) => {
                const view = privateViews.find((v) => v.channel_id === id);
                const key = keyed.get(id);
                return (
                  <tr key={id}>
                    <td>#{view?.name ?? key?.name ?? "?"}{!view && <span className="badge badge-xs badge-ghost ml-1">not folded</span>}</td>
                    <td><Mono title={id}>{shortHex(id)}</Mono></td>
                    <td>{view?.accessible ? <span className="badge badge-sm badge-success">accessible</span> : <span className="badge badge-sm badge-ghost">no key</span>}</td>
                    <td>{key?.epoch ?? "—"}</td>
                    <td><Mono>{key ? fingerprint(key.key) : "—"}</Mono></td>
                    <td>
                      {(key?.held ?? []).length === 0 ? (
                        <span className="opacity-60">none</span>
                      ) : (
                        <div className="flex flex-col">
                          {key!.held!.map((h) => (
                            <span key={h.epoch} className="whitespace-nowrap">
                              epoch {h.epoch} · retired {dateTime(h.retired_at && h.retired_at * 1000)}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ---- diagnostics -----------------------------------------------------------

type LogEntry = { at: number; kind: "rotation"; d: RotationDiagnostic } | { at: number; kind: "background"; d: ConcordDiagnostic };

function DiagnosticsCard({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const [log, setLog] = useState<LogEntry[]>([]);
  useEffect(() => {
    if (!community) return;
    const push = (e: LogEntry) => setLog((prev) => [e, ...prev].slice(0, 50));
    const a = community.rotationDiagnostics$.subscribe((d) => push({ at: Date.now(), kind: "rotation", d }));
    const b = community.diagnostics$.subscribe((d) => push({ at: Date.now(), kind: "background", d }));
    return () => {
      a.unsubscribe();
      b.unsubscribe();
    };
  }, [community]);
  return (
    <Card title="Diagnostics" summary={`${log.length} since opened`}>
      <p className="opacity-70">Rotation decisions (parked / rejected candidates) and background failures, captured while this page is open.</p>
      {log.length === 0 ? (
        <p className="opacity-60">Nothing yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {log.map((e, i) =>
            e.kind === "rotation" ? (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="opacity-50 whitespace-nowrap">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={`badge badge-sm ${e.d.status === "rejected" ? "badge-error" : "badge-warning"}`}>{e.d.status}</span>
                <span>{e.d.reason}</span>
                {e.d.attempt !== undefined && <span className="opacity-60">attempt {e.d.attempt}</span>}
                <span className="opacity-60">{e.d.scopeId === cid ? "root" : `channel ${shortHex(e.d.scopeId)}`}</span>
                <Mono title={e.d.candidateId}>{shortHex(e.d.candidateId)}</Mono>
              </div>
            ) : (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="opacity-50 whitespace-nowrap">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="badge badge-sm badge-ghost">{e.d.stage}</span>
                <span className="break-all">{e.d.error instanceof Error ? e.d.error.message : String(e.d.error)}</span>
              </div>
            ),
          )}
        </div>
      )}
    </Card>
  );
}

// ---- raw -------------------------------------------------------------------

function RawCard({ material }: { material: JoinMaterial }) {
  const json = stringify(material, true);
  const [copied, setCopied] = useState(false);
  return (
    <Card title="Raw material" summary="secrets replaced by fingerprints">
      <div>
        <button
          className="btn btn-ghost btn-xs gap-1"
          onClick={() => {
            void navigator.clipboard.writeText(json).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />} Copy
        </button>
      </div>
      <pre className="max-h-[50vh] overflow-auto rounded-box bg-base-300 p-3 font-mono text-xs whitespace-pre select-text">{json}</pre>
    </Card>
  );
}

// ---- page ------------------------------------------------------------------

export function CommunityDebugPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  // Material is a getter replaced wholesale on adoption; these streams re-render on epoch and key changes.
  use$(() => community?.epoch$, [community]);
  use$(() => community?.channelViews$, [community]);
  const metadata = use$(() => community?.metadata$, [community]);
  const material = community?.material;

  const keys = useMemo(() => {
    if (!material) return [];
    const out: ConcordKeys[] = [];
    try {
      for (const m of buildChain(material)) out.push(deriveConcordKeys(m, [], out[out.length - 1]));
    } catch (e) {
      console.warn("[debug] key derivation failed", e);
    }
    return out;
  }, [material]);

  if (!community || !material) return null;
  const relays = [...new Set([...relaysFor(material), ...(metadata?.relays ?? [])])];

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Debug</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Technical state of this community: key generations, rotations and their presence on relays. Read-only.
      </p>
      <StatusCard cid={cid} />
      <GenerationsCard material={material} keys={keys} />
      <RelayAuditCard key={`${cid}:${material.root_epoch}`} material={material} relays={relays} />
      <MembershipCard cid={cid} />
      <ChannelsCard cid={cid} material={material} />
      <DiagnosticsCard cid={cid} />
      <RawCard material={material} />
    </>
  );
}
