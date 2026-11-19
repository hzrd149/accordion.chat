/**
 * Community Debug — a developer-mode page in community settings showing one
 * community's technical state in horizontal tabs: sync status, the full control
 * plane (per-epoch addresses and coverage, verification, folded state, edition
 * chains), the root generations this device holds, an on-demand per-relay audit
 * of every held epoch's planes and the CORD-06 rotations between them, current
 * and per-epoch membership, private channel key epochs, live diagnostics and the
 * (redacted) raw material. Only the control plane's Publish tab writes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { use$ } from "applesauce-react/hooks";
import type { ConcordDiagnostic, JoinMaterial, RotationDiagnostic } from "@applesauce/concord";
import { verifyOwner } from "@applesauce/concord/helpers";
import { ChevronRight, RefreshCw } from "lucide-react";
import { pool } from "../../nostr";
import { useConcord } from "../../hooks/use-concord";
import { useCommunity } from "../../hooks/use-community";
import { UserLabel } from "../User";
import {
  AUDIT_PLANES,
  auditEpoch,
  buildChain,
  dateTime,
  diffMembers,
  deriveGenerationKeys,
  fingerprint,
  generationRows,
  relaysFor,
  stringify,
  type AuditPlane,
  type EpochAudit,
  type GenerationKeys,
  type RotationAudit,
} from "../../helpers/concord-history";
import { DebugSection as Card, DebugTabs, Hex, JsonBlock, KV, UserList } from "./debug-ui";
import { ControlPlaneInspector } from "./ControlPlaneDebugger";

const NO_SET: ReadonlySet<string> = new Set();
const NO_GRANTS: ReadonlyMap<string, string[]> = new Map();

/** A rotation's relay date and the local `retired_at` may differ by publish latency; flag beyond this. */
const DATE_SKEW_WARN_MS = 5 * 60_000;

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
      summary={
        <>
          <span className={`badge ${phaseBadge}`}>{status?.phase ?? "…"}</span> epoch {status?.epoch ?? material.root_epoch}
        </>
      }
    >
      <KV label="phase">
        <span className={`badge ${phaseBadge}`}>{status?.phase ?? "…"}</span>{" "}
        <span className={`badge ${status?.connected ? "badge-success" : "badge-ghost"}`}>{status?.connected ? "connected" : "disconnected"}</span>
      </KV>
      {status?.error && <KV label="last error"><span className="text-error">{status.error}</span></KV>}
      <KV label="community_id"><Hex value={cid} full /></KV>
      <KV label="owner">
        <span className="inline-flex items-center gap-2">
          <UserLabel pubkey={material.owner} />
          {verifyOwner(material) ? <span className="badge badge-success">proof ok</span> : <span className="badge badge-error">proof failed</span>}
        </span>
      </KV>
      <KV label="root epoch">{material.root_epoch}</KV>
      <KV label="refounder">{material.refounder ? <UserLabel pubkey={material.refounder} /> : <span className="opacity-60">— (genesis)</span>}</KV>
      <KV label="material rev">{material.rev ?? 0}</KV>
      <KV label="control">
        {material.control_pk ? (
          <>
            split · <Hex value={material.control_pk} />{" "}
            {material.control_root ? <span className="badge badge-success">signing root held</span> : <span className="badge badge-ghost">read only</span>}
          </>
        ) : (
          "legacy (derived from root)"
        )}
      </KV>
      <KV label="relays">
        <div className="flex flex-col">
          {relays.map((r) => (
            <span key={r} className="font-mono">
              {r}
              {!material.relays.includes(r) && <span className="badge badge-ghost ml-2">metadata only</span>}
            </span>
          ))}
        </div>
      </KV>
      <div className="flex flex-col gap-1.5">
        <span className="font-semibold opacity-70">Community List</span>
        {entry ? (
          <>
            <KV label="seed epoch">{entry.seed.root_epoch}</KV>
            <KV label="listed current epoch">
              {entry.current.root_epoch}
              {entry.current.root_epoch !== material.root_epoch && <span className="badge badge-warning ml-2">differs from engine ({material.root_epoch})</span>}
            </KV>
            <KV label="added">{dateTime(entry.added_at)}</KV>
          </>
        ) : (
          <p className="text-warning">No Community List entry for this community.</p>
        )}
        <KV label="list state">
          {memberships?.knowledge ?? "…"}
          {memberships?.pending && <span className="badge badge-warning ml-2">save pending</span>}
          {memberships?.locked && <span className="badge badge-warning ml-2">fragment locked</span>}
        </KV>
      </div>
    </Card>
  );
}

// ---- generations -----------------------------------------------------------

function GenerationsCard({ material, keys }: { material: JoinMaterial; keys: GenerationKeys[] }) {
  const rows = useMemo(() => generationRows(material), [material]);
  const first = rows[0]?.epoch ?? material.root_epoch;
  const problems = rows.filter((r) => r.gapBefore || (!r.current && r.retiredAt === undefined)).length;
  return (
    <Card
      title="Generations"
      summary={
        <>
          {rows.length} held (epoch {first} → {material.root_epoch})
          {problems > 0 && <span className="badge badge-warning ml-2">{problems} flagged</span>}
        </>
      }
    >
      <div className="overflow-x-auto">
        <table className="table text-base">
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
                  {r.current && <span className="badge badge-primary ml-1">current</span>}
                  {r.gapBefore && <span className="badge badge-warning ml-1" title="The epoch before this one is not held">gap</span>}
                </td>
                <td><Hex value={r.rootFingerprint} /></td>
                <td>{r.refounder ? <UserLabel pubkey={r.refounder} /> : <span className="opacity-60">{r.epoch === 0 ? "genesis" : "unknown"}</span>}</td>
                <td className="whitespace-nowrap">{r.epoch === first && r.activeFrom === undefined ? "—" : dateTime(r.activeFrom && r.activeFrom * 1000)}</td>
                <td className="whitespace-nowrap">
                  {r.current ? <span className="opacity-60">current</span> : r.retiredAt !== undefined ? dateTime(r.retiredAt * 1000) : <span className="text-warning">missing retired_at</span>}
                </td>
                <td>
                  {keys[i]?.error ? <span className="text-error">Derivation failed: {keys[i].error}</span> : <Hex value={keys[i]?.keys?.control.pk} />}
                </td>
                <td><Hex value={keys[i]?.keys?.guestbook.pk} /></td>
                <td><Hex value={keys[i]?.keys?.nextBaseRekey.key.pk} /></td>
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
      <table className="table text-base">
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
              <tr key={`${a.epoch}:${plane}`} className={a.epoch % 2 ? "bg-base-200/50" : undefined}>
                <td>{pi === 0 ? a.epoch : ""}</td>
                <td className="whitespace-nowrap">{plane === "rekey" ? `rekey → ${a.epoch + 1}` : PLANE_LABEL[plane]}</td>
                <td><Hex value={a.addresses[plane]} /></td>
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
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`font-semibold ${rotation.complete && rotation.consistent ? "" : "text-error"}`}>Epoch {rotation.prevEpoch} → {rotation.newEpoch}</span>
        {rotation.complete ? <span className="badge badge-success">complete</span> : <span className="badge badge-error">incomplete</span>}
        {rotation.consistent ? <span className="badge badge-success badge-outline">consistent</span> : <span className="badge badge-error">inconsistent: {rotation.inconsistencies.join(", ")}</span>}
        {isTip && <span className="badge badge-warning">not adopted</span>}
        <Hex value={rotation.candidateId} />
      </div>
      <KV label="rotator">
        <span className="inline-flex flex-wrap items-center gap-2">
          <UserLabel pubkey={rotation.rotator} />
          <Hex value={rotation.rotator} />
          {rotation.vac ? (
            <span className="opacity-60 inline-flex items-center gap-1">via grant <Hex value={rotation.vac[0]} /> v{rotation.vac[1]}</span>
          ) : (
            <span className="opacity-60">(owner, no vac)</span>
          )}
        </span>
      </KV>
      <KV label="published (relay)">
        {dateTime(rotation.firstMs)}
        {skew !== undefined && skew > DATE_SKEW_WARN_MS && <span className="badge badge-warning ml-2">local retired_at {dateTime(retiredAt! * 1000)}</span>}
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
              <span key={r} className="font-mono">
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
          <summary className="cursor-pointer text-warning">{rotation.notRekeyed.length} not rekeyed</summary>
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
          <details key={a.epoch} className="group/epoch">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden flex flex-wrap items-center gap-2 py-1 hover:bg-base-200">
              <ChevronRight size={16} className="opacity-60 transition-transform group-open/epoch:rotate-90" />
              <span className="font-semibold">Epoch {a.epoch}</span>
              <span className="badge badge-ghost">{a.state.members.size} members</span>
              {added.length > 0 && <span className="badge badge-success badge-outline">+{added.length}</span>}
              {removed.length > 0 && <span className="badge badge-error badge-outline">−{removed.length}</span>}
              {a.state.banlist.size > 0 && <span className="badge badge-ghost">{a.state.banlist.size} banned</span>}
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
    // A first run fills in epoch by epoch; a re-check keeps the previous results on screen and swaps them in at the end,
    // so the page doesn't collapse and regrow under the reader.
    const progressive = audits.length === 0;
    const chain = buildChain(material);
    const out: EpochAudit[] = [];
    try {
      for (const m of chain) {
        if (!alive.current) return;
        setProgress(`Auditing epoch ${m.root_epoch} (${out.length + 1}/${chain.length})…`);
        out.push(await auditEpoch(pool, m, out[out.length - 1]?.keys, relays));
        if (alive.current && progressive) setAudits([...out]);
      }
      if (alive.current) {
        setAudits(out);
        setCheckedAt(Date.now());
      }
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
  const undecodable = audits.reduce((n, a) => n + a.undecodable, 0);
  const rotationCount = audits.reduce((n, a) => n + a.rotations.length, 0);
  const malformed = audits.flatMap((a) => a.malformed.map((m) => ({ ...m, epoch: a.epoch })));
  const status = progress || (checkedAt ? `Last checked ${dateTime(checkedAt)}` : "Not run yet");

  return (
    <>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary btn-sm gap-1.5 w-36" disabled={busy} onClick={() => void run()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : <RefreshCw size={14} />}
          Check relays
        </button>
        <span className="text-sm opacity-60 whitespace-nowrap">{status}</span>
      </div>
      {error && <div className="alert alert-error py-2">{error}</div>}

      {audits.length === 0 ? (
        <div className="border border-dashed border-base-300 rounded-box py-12 text-center opacity-60">
          {busy ? "Waiting for the first epoch…" : `${relays.length} relays`}
        </div>
      ) : (
        <div className={`flex flex-col gap-6 transition-opacity ${busy && checkedAt ? "opacity-60" : ""}`}>
          <Card title="Presence" summary={`${audits.length} epochs × ${relays.length} relays`}>
            <PresenceMatrix audits={audits} relays={relays} />
            {undecodable > 0 && <p className="text-warning">{undecodable} undecodable wraps.</p>}
          </Card>

          <Card title="Rotations" summary={`${rotationCount} found`}>
            {missingTransitions.map((a) => (
              <p key={a.epoch} className="text-error font-semibold">
                Epoch {a.epoch} → {a.epoch + 1}: no rekey events on any relay.
              </p>
            ))}
            {tip && tip.rotations.length > 0 && (
              <p className="text-warning font-semibold">
                Unadopted rotation to epoch {tip.epoch + 1} (see Diagnostics).
              </p>
            )}
            {audits.some((a) => a.rotations.length > 1) && (
              <p className="text-warning">Competing candidates for one transition (lowest key wins).</p>
            )}
            {malformed.map((m) => (
              <p key={m.wrapId} className="text-error">
                Epoch {m.epoch}: malformed rekey <Hex value={m.wrapId} /> ({m.reason})
              </p>
            ))}
            {rotationCount === 0 && missingTransitions.length === 0 && (
              <p className="opacity-60">Single generation, no rotations.</p>
            )}
            <div className="flex flex-col divide-y divide-base-300">
              {audits.flatMap((a) =>
                a.rotations.map((r) => (
                  <div key={r.candidateId} className="py-3 first:pt-0">
                    <RotationCard rotation={r} relays={relays} retiredAt={retired.get(a.epoch)} isTip={a.epoch === material.root_epoch} />
                  </div>
                )),
              )}
            </div>
          </Card>

          <Card title="Members by epoch">
            <MembersByEpoch audits={audits} />
          </Card>
        </div>
      )}
    </>
  );
}

// ---- membership / channels -------------------------------------------------

function MembershipCard({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const members = use$(() => community?.members$, [community]) ?? NO_SET;
  const banlist = use$(() => community?.banlist$, [community]) ?? NO_SET;
  const grants = use$(() => community?.grants$, [community]) ?? NO_GRANTS;
  const roles = use$(() => community?.roles$, [community]);
  const roleName = (id: string) => roles?.find((r) => r.role_id === id)?.name;
  return (
    <Card title="Current membership" summary={`${members.size} members · ${grants.size} grants · ${banlist.size} banned`}>
      <div className="flex flex-col gap-1">
        {[...members].map((m) => (
          <div key={m} className="flex flex-wrap items-center gap-2">
            <UserLabel pubkey={m} />
            <Hex value={m} />
            {(grants.get(m) ?? []).map((id) => (
              <span key={id} className="badge badge-outline">{roleName(id) ?? <Hex value={id} />}</span>
            ))}
          </div>
        ))}
      </div>
      {banlist.size > 0 && (
        <div>
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
          <table className="table text-base">
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
                    <td>#{view?.name ?? key?.name ?? "?"}{!view && <span className="badge badge-ghost ml-1">not folded</span>}</td>
                    <td><Hex value={id} /></td>
                    <td>{view?.accessible ? <span className="badge badge-success">accessible</span> : <span className="badge badge-ghost">no key</span>}</td>
                    <td>{key?.epoch ?? "—"}</td>
                    <td><Hex value={key ? fingerprint(key.key) : undefined} /></td>
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

/** Capture rotation decisions and background failures for as long as the Debug page is open, whichever tab is shown. */
function useDiagnosticsLog(cid: string): LogEntry[] {
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
  return log;
}

function DiagnosticsCard({ cid, log }: { cid: string; log: LogEntry[] }) {
  return (
    <Card title="Diagnostics" summary={`${log.length} since opened`}>
      {log.length === 0 ? (
        <p className="opacity-60">Nothing yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {log.map((e, i) =>
            e.kind === "rotation" ? (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="opacity-50 whitespace-nowrap">{new Date(e.at).toLocaleTimeString()}</span>
                <span className={`badge ${e.d.status === "rejected" ? "badge-error" : "badge-warning"}`}>{e.d.status}</span>
                <span>{e.d.reason}</span>
                {e.d.attempt !== undefined && <span className="opacity-60">attempt {e.d.attempt}</span>}
                {e.d.scopeId === cid ? <span className="opacity-60">root</span> : <span className="opacity-60 inline-flex items-center gap-1">channel <Hex value={e.d.scopeId} /></span>}
                <Hex value={e.d.candidateId} />
              </div>
            ) : (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <span className="opacity-50 whitespace-nowrap">{new Date(e.at).toLocaleTimeString()}</span>
                <span className="badge badge-ghost">{e.d.stage}</span>
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
  return (
    <Card title="Raw material" summary="secrets replaced by fingerprints">
      <JsonBlock json={stringify(material, true)} />
    </Card>
  );
}

// ---- page ------------------------------------------------------------------

const TABS = [
  { id: "status", label: "Status" },
  { id: "control", label: "Control plane" },
  { id: "generations", label: "Generations" },
  { id: "relays", label: "Relay audit" },
  { id: "members", label: "Membership" },
  { id: "channels", label: "Private channels" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "raw", label: "Raw" },
] as const;
type TabId = (typeof TABS)[number]["id"];

export function CommunityDebugPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  // Material is a getter replaced wholesale on adoption; these streams re-render on epoch and key changes.
  use$(() => community?.epoch$, [community]);
  use$(() => community?.channelViews$, [community]);
  const metadata = use$(() => community?.metadata$, [community]);
  const material = community?.material;
  const log = useDiagnosticsLog(cid);

  // The selected tab lives in `?tab=` so a reload or shared link reopens it.
  const [params, setParams] = useSearchParams();
  const tabParam = params.get("tab");
  const tab: TabId = TABS.some((t) => t.id === tabParam) ? (tabParam as TabId) : "status";
  // Tabs mount on first visit and then stay mounted (hidden), so a relay audit or diagnostics log survives switching.
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set([tab]));
  if (!visited.has(tab)) setVisited(new Set([...visited, tab]));
  const selectTab = (id: TabId) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("tab", id);
        return next;
      },
      { replace: true },
    );

  const keys = useMemo(() => material ? deriveGenerationKeys(material) : [], [material]);

  if (!community || !material) return null;
  const relays = [...new Set([...relaysFor(material), ...(metadata?.relays ?? [])])];
  const tabs = TABS.map((t) => (t.id === "diagnostics" && log.length > 0 ? { ...t, label: <>{t.label} <span className="badge badge-warning badge-xs">{log.length}</span></> } : t));

  const panel = (id: TabId) => {
    switch (id) {
      case "status":
        return <StatusCard cid={cid} />;
      case "control":
        return <ControlPlaneInspector cid={cid} />;
      case "generations":
        return <GenerationsCard material={material} keys={keys} />;
      case "relays":
        return <RelayAuditCard key={`${cid}:${material.root_epoch}`} material={material} relays={relays} />;
      case "members":
        return <MembershipCard cid={cid} />;
      case "channels":
        return <ChannelsCard cid={cid} material={material} />;
      case "diagnostics":
        return <DiagnosticsCard cid={cid} log={log} />;
      case "raw":
        return <RawCard material={material} />;
    }
  };

  return (
    <>
      {/* Flush with the settings pane: cancel its padding so the tab strip meets the top and side edges. */}
      <div className="-mx-10 -mt-10 mb-6 px-6 border-b border-base-300 max-md:-mx-4 max-md:-mt-6 max-md:px-2">
        <DebugTabs tabs={tabs} value={tab} onChange={selectTab} />
      </div>
      {TABS.filter((t) => visited.has(t.id)).map((t) => (
        <div key={t.id} hidden={t.id !== tab} className="flex flex-col gap-6">
          {panel(t.id)}
        </div>
      ))}
    </>
  );
}
