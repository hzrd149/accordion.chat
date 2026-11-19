/**
 * Plain, redacted snapshots of one community's debug state, for the Debug page's
 * copy buttons. Each section builder returns a JSON-safe object (no key material:
 * secrets become fingerprints, derived addresses are public keys only), so the
 * output can be pasted into an issue or handed to an agent. `debugReport` bundles
 * every section into one document.
 */
import type { ObservedValueOf } from "rxjs";
import type {
  CommunityState,
  ConcordCommunity,
  ConcordClient,
  ConcordDiagnostic,
  ConcordPlaneSyncCoverage,
  DecodedEvent,
  JoinMaterial,
  RotationDiagnostic,
  Rumor,
} from "@applesauce/concord";
import { isCurrentStaff } from "@applesauce/concord/helpers";
import { fingerprint, generationRows, stringify, type EpochAudit, type GenerationKeys } from "./concord-history";
import { tagVal, vskLabel } from "./control-debug";

export type DiagnosticLogEntry = { at: number; kind: "rotation"; d: RotationDiagnostic } | { at: number; kind: "background"; d: ConcordDiagnostic };

type Status = ObservedValueOf<ConcordCommunity["status$"]>;
type Memberships = ObservedValueOf<ConcordClient["memberships$"]>;
type ChannelViews = ObservedValueOf<ConcordCommunity["channelViews$"]>;
type Roles = ObservedValueOf<ConcordCommunity["roles$"]>;
type Coverage = ObservedValueOf<ConcordCommunity["syncCoverage$"]>;

const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString());
const isoSec = (s: number | undefined) => (s === undefined ? undefined : iso(s * 1000));

export function errorText(e: unknown): string | undefined {
  if (e === undefined || e === null) return undefined;
  if (e instanceof Error) return e.cause !== undefined ? `${e.name}: ${e.message} (cause: ${errorText(e.cause)})` : `${e.name}: ${e.message}`;
  return typeof e === "string" ? e : stringify(e);
}

/** Serialize a snapshot for the clipboard, always redacting secret fields. */
export const toClipboard = (value: unknown) => stringify(value, true);

// ---- sections ----------------------------------------------------------------

export function statusSnapshot(cid: string, material: JoinMaterial, status: Status | undefined, memberships: Memberships | undefined, relays: string[]) {
  const entry = memberships?.entries.find((e) => e.community_id === cid);
  return {
    community_id: cid,
    name: material.name,
    phase: status?.phase,
    connected: status?.connected,
    status_epoch: status?.epoch,
    last_error: status?.error,
    owner: material.owner,
    root_epoch: material.root_epoch,
    refounder: material.refounder,
    material_rev: material.rev ?? 0,
    control: material.control_pk ? { mode: "split", control_pk: material.control_pk, signing_root_held: !!material.control_root } : { mode: "legacy" },
    relays: relays.map((r) => ({ url: r, in_material: material.relays.includes(r) })),
    community_list: {
      knowledge: memberships?.knowledge,
      pending: memberships?.pending,
      locked: memberships?.locked,
      entry: entry
        ? { seed_epoch: entry.seed.root_epoch, current_epoch: entry.current.root_epoch, added_at: iso(entry.added_at) }
        : null,
    },
  };
}

export function generationsSnapshot(material: JoinMaterial, keys: GenerationKeys[]) {
  return generationRows(material).map((r, i) => ({
    epoch: r.epoch,
    current: r.current,
    gap_before: r.gapBefore,
    root_fingerprint: r.rootFingerprint,
    refounder: r.refounder,
    active_from: isoSec(r.activeFrom),
    retired_at: isoSec(r.retiredAt),
    control_pk: keys[i]?.keys?.control.pk,
    control_signing_held: !!keys[i]?.keys?.control.signing,
    guestbook_pk: keys[i]?.keys?.guestbook.pk,
    next_rekey_pk: keys[i]?.keys?.nextBaseRekey.key.pk,
    derivation_error: keys[i]?.error,
  }));
}

export function membershipSnapshot(
  members: ReadonlySet<string>,
  banlist: ReadonlySet<string>,
  grants: ReadonlyMap<string, string[]>,
  roles: Roles | undefined,
  state?: CommunityState,
) {
  const roleName = (id: string) => roles?.find((r) => r.role_id === id)?.name;
  return {
    members: [...members].map((pubkey) => ({
      pubkey,
      roles: (grants.get(pubkey) ?? []).map((id) => ({ id, name: roleName(id) })),
      ...(state ? { current_staff: isCurrentStaff(state, pubkey) } : {}),
    })),
    banlist: [...banlist].map((pubkey) => ({ pubkey, banned_at: isoSec(state?.bannedAt?.get(pubkey)) })),
    lifted_bans: state ? [...(state.bannedAt?.keys() ?? [])].filter((p) => !banlist.has(p)) : undefined,
    grants_without_membership: [...grants.keys()].filter((p) => !members.has(p)),
  };
}

export function channelsSnapshot(views: ChannelViews | undefined, material: JoinMaterial) {
  const privateViews = (views ?? []).filter((v) => v.private);
  const keyed = new Map(material.channels.map((c) => [c.id, c]));
  const ids = [...new Set([...privateViews.map((v) => v.channel_id), ...keyed.keys()])];
  return {
    private_channels: ids.map((id) => {
      const view = privateViews.find((v) => v.channel_id === id);
      const key = keyed.get(id);
      return {
        channel_id: id,
        name: view?.name ?? key?.name,
        folded: !!view,
        accessible: !!view?.accessible,
        key_epoch: key?.epoch,
        key_fingerprint: key ? fingerprint(key.key) : undefined,
        held_prior: (key?.held ?? []).map((h) => ({ epoch: h.epoch, retired_at: isoSec(h.retired_at) })),
      };
    }),
    unheld_list_entries: material.unheld_channels?.length ?? 0,
  };
}

export function diagnosticsSnapshot(cid: string, log: DiagnosticLogEntry[]) {
  return log.map((e) =>
    e.kind === "rotation"
      ? {
          at: iso(e.at),
          kind: "rotation",
          status: e.d.status,
          reason: e.d.reason,
          attempt: e.d.attempt,
          scope: e.d.scopeId === cid ? "root" : { channel: e.d.scopeId },
          candidate_id: e.d.candidateId,
          cause: errorText(e.d.cause),
        }
      : {
          at: iso(e.at),
          kind: "background",
          stage: e.d.stage,
          // `key` is a public scope identifier; renamed so redaction does not fingerprint it.
          scope_id: e.d.key,
          attempt: e.d.attempt,
          error: errorText(e.d.error),
          ...("plane" in e.d ? { plane: e.d.plane } : {}),
          ...("duty" in e.d ? { duty: e.d.duty } : {}),
          ...("reason" in e.d ? { reason: e.d.reason } : {}),
        },
  );
}

function coverageSnapshot(c: ConcordPlaneSyncCoverage | undefined) {
  if (!c) return null;
  return {
    state: c.state,
    lane: c.lane,
    epoch: c.epoch,
    retained: c.retained,
    relays: Object.fromEntries(Object.entries(c.relays).map(([u, r]) => [u, r.state])),
    error: errorText(c.error),
    ingestion: (c as { ingestion?: unknown }).ingestion,
  };
}

export function planesSnapshot(material: JoinMaterial, keys: GenerationKeys[], coverage: Coverage | undefined, relays: string[]) {
  return {
    mode: material.control_pk ? "split" : "legacy",
    root_epoch: material.root_epoch,
    relays,
    per_epoch: generationRows(material).map((r, i) => {
      const addr = keys[i]?.keys?.control.pk;
      return {
        epoch: r.epoch,
        current: r.current,
        control_address: addr,
        write: !!keys[i]?.keys?.control.signing,
        derivation_error: keys[i]?.error,
        coverage: coverageSnapshot(addr ? coverage?.get(addr) : undefined),
      };
    }),
    // Coverage for every other plane this community reads (guestbook, channels, history lanes).
    all_coverage: coverage ? [...coverage].map(([author, c]) => ({ author, ...coverageSnapshot(c) })) : [],
  };
}

const editionRef = (d: DecodedEvent) => ({
  rumor_id: d.rumor.id,
  author: d.author,
  seal: d.sealKind,
  at: iso(d.ms),
  read_epoch: (d as { readSource?: { epoch: number } }).readSource?.epoch,
});

type HeadLike = { edition: DecodedEvent; vsk: number; eid: string; version: number | string; hash: string; prevHash?: string };
const headSnapshot = (h: HeadLike) => ({ entity: vskLabel(h.vsk), vsk: h.vsk, eid: h.eid, ev: String(h.version), hash: h.hash, prev_hash: h.prevHash, ...editionRef(h.edition) });

export function verificationSnapshot(state: CommunityState) {
  const cv = state.controlVerification;
  if (!cv) return null;
  return {
    pending: cv.pending.map((p) => ({ reason: p.reason, eid: p.eid, ev: p.version !== undefined ? String(p.version) : undefined, hash: p.hash, actor: p.actor })),
    suspended: [...cv.suspended].map((eid) => {
      const head = state.heads?.get(eid);
      return { eid, entity: head ? vskLabel(tagVal(head.rumor, "vsk")) : undefined, display_ev: head ? tagVal(head.rumor, "ev") : undefined, display_author: head?.author };
    }),
    display_only_heads: [...(state.heads ?? [])]
      .filter(([eid]) => !cv.heads.has(eid))
      .map(([eid, d]) => ({ eid, entity: vskLabel(tagVal(d.rumor, "vsk")), ev: tagVal(d.rumor, "ev"), ...editionRef(d) })),
    verified_heads: [...cv.heads.values()].map(headSnapshot),
    removal_floors: [...cv.removals.values()].map(headSnapshot),
    grant_history: [...cv.grantHistory].map(([coord, editions]) => ({
      coord,
      member: editions[0]?.member,
      editions: editions.map((g) => ({ ev: String(g.version), hash: g.hash, role_ids: g.roleIds, ...editionRef(g.edition) })),
    })),
  };
}

/** Per-entity edition chains, without contents (use the Editions tab for full rumors). */
export function editionChainsSnapshot(rumors: Rumor[], state: CommunityState) {
  const cv = state.controlVerification;
  const displayed = new Set<string>();
  state.heads?.forEach((d) => displayed.add(d.rumor.id));
  const verified = new Set<string>();
  cv?.heads.forEach((h) => verified.add(h.edition.rumor.id));
  const chains = new Map<string, { entity: string; vsk: string; eid: string; editions: object[] }>();
  for (const r of rumors) {
    const vsk = tagVal(r, "vsk") ?? "?";
    const eid = tagVal(r, "eid") ?? "?";
    const k = `${vsk}:${eid}`;
    if (!chains.has(k)) chains.set(k, { entity: vskLabel(vsk), vsk, eid, editions: [] });
    chains.get(k)!.editions.push({
      ev: tagVal(r, "ev"),
      rumor_id: r.id,
      author: r.pubkey,
      created_at: isoSec(r.created_at),
      displayed: displayed.has(r.id),
      verified: verified.has(r.id),
    });
  }
  return [...chains.values()];
}

export function auditSnapshot(audits: EpochAudit[], relays: string[], checkedAt: number | null) {
  return {
    checked_at: iso(checkedAt ?? undefined),
    relays,
    epochs: audits.map((a, i) => {
      const prev = i > 0 ? audits[i - 1].state.members : undefined;
      return {
        epoch: a.epoch,
        addresses: a.addresses,
        per_relay: Object.fromEntries([...a.relays].map(([u, r]) => [u, r.ok ? r.counts : { error: r.error }])),
        totals: a.totals,
        undecodable: a.undecodable,
        members: [...a.state.members],
        members_added: prev ? [...a.state.members].filter((m) => !prev.has(m)) : undefined,
        members_removed: prev ? [...prev].filter((m) => !a.state.members.has(m)) : undefined,
        banlist: [...a.state.banlist],
        malformed_rekeys: a.malformed,
        rotations: a.rotations.map((r) => ({
          candidate_id: r.candidateId,
          prev_epoch: r.prevEpoch,
          new_epoch: r.newEpoch,
          rotator: r.rotator,
          vac: r.vac,
          published: iso(r.firstMs),
          complete: r.complete,
          consistent: r.consistent,
          inconsistencies: r.inconsistencies,
          chunks: { count: r.chunkCount, held: r.chunksHeld, missing: r.missingIndexes },
          chunks_by_relay: Object.fromEntries(r.chunksByRelay),
          blob_count: r.blobCount,
          rekeyed: r.rekeyed,
          not_rekeyed: r.notRekeyed,
        })),
      };
    }),
  };
}

// ---- full report -------------------------------------------------------------

export type DebugReportSections = Record<string, unknown>;

/** One redacted JSON document with every section, headed by where and when it was taken. */
export function debugReport(cid: string, sections: DebugReportSections): string {
  return toClipboard({
    report: "accordion community debug report",
    generated_at: new Date().toISOString(),
    app_origin: typeof location !== "undefined" ? location.origin : undefined,
    user_agent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
    community_id: cid,
    note: "Secret keys and tokens are replaced by fingerprints (fp:…). Pubkeys and event ids are public.",
    ...sections,
  });
}
