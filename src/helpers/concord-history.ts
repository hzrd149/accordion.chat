/**
 * Concord epoch-history helpers shared by the developer tools: rebuild the chain of
 * held root epochs from local material, fetch plane wraps (in aggregate or per
 * relay), and audit one epoch — folding its members and checking the CORD-06
 * rotation that left it for completeness and recipient coverage. Network functions
 * take the `RelayPool` as an argument so the pure parts stay testable.
 */
import type { NostrEvent } from "applesauce-core/helpers/event";
import type { RelayPool } from "applesauce-relay";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { firstValueFrom, timeout, toArray } from "rxjs";
import { StreamSigners, type CommunityState, type DecodedEvent, type JoinMaterial, type Role } from "@applesauce/concord";
import {
  decodeWrap,
  deriveConcordKeys,
  EPHEMERAL_GIFT_WRAP_KIND,
  foldControl,
  foldMembers,
  GIFT_WRAP_KIND,
  groupRotations,
  parseRekeyResult,
  rekeyLocator,
  resolveStanding,
  ROOT_SCOPE_HEX,
  STOCK_RELAYS,
  type ConcordKeys,
  type ParsedRekey,
  type RekeyParseReason,
} from "@applesauce/concord/helpers";

// ---- formatting ------------------------------------------------------------

export function shortHex(hex: string | undefined): string {
  if (!hex) return "—";
  return hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex;
}

/** A full local date and time for debug views, or an em dash when unknown. */
export function dateTime(ms: number | undefined): string {
  if (ms === undefined) return "—";
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
}

/** A stable, non-secret identifier for a secret hex key: the first 8 bytes of its sha256. */
export function fingerprint(hex: string | undefined): string {
  if (!hex) return "—";
  try {
    return bytesToHex(sha256(hexToBytes(hex))).slice(0, 16);
  } catch {
    return "invalid";
  }
}

/** Material fields holding secret key bytes or bearer tokens; redacted to fingerprints for display. */
const SECRET_FIELDS = new Set(["community_root", "control_root", "prev_root", "key", "sk", "signer_sk", "token"]);

/**
 * JSON.stringify that survives bigint/Map/Set/Error/bytes and, with `redact`, replaces
 * secret keys by fingerprints (and drops raw byte arrays, which are key material here).
 */
export function stringify(value: unknown, redact = false): string {
  return JSON.stringify(
    value,
    (k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      if (v instanceof Error) return { name: v.name, message: v.message, ...(v.cause !== undefined ? { cause: v.cause } : {}) };
      if (v instanceof Uint8Array) return redact ? `<${v.length} bytes>` : bytesToHex(v);
      if (redact && SECRET_FIELDS.has(k) && typeof v === "string") return `fp:${fingerprint(v)}`;
      return v;
    },
    2,
  );
}

// ---- local generations -----------------------------------------------------

type ChainEntry = {
  epoch: number;
  key: string;
  refounder?: string;
  control_pk?: string;
  control_root?: string;
  prev_root?: string;
  retired_at?: number;
};

/** Omit undefined coordinates, but retain malformed supplied values for strict validation. */
function epochFields(r: Pick<ChainEntry, "refounder" | "control_pk" | "control_root" | "prev_root">) {
  return {
    ...(r.refounder !== undefined ? { refounder: r.refounder } : {}),
    ...(r.control_pk !== undefined ? { control_pk: r.control_pk } : {}),
    ...(r.control_root !== undefined ? { control_root: r.control_root } : {}),
    ...(r.prev_root !== undefined ? { prev_root: r.prev_root } : {}),
  };
}

function chainEntries(material: JoinMaterial): ChainEntry[] {
  const byEpoch = new Map<number, ChainEntry>();
  for (const r of material.held_roots ?? []) {
    byEpoch.set(r.epoch, {
      epoch: r.epoch,
      key: r.key,
      ...epochFields(r),
      ...(r.retired_at !== undefined ? { retired_at: r.retired_at } : {}),
    });
  }
  // The current epoch wins over a stale held duplicate.
  byEpoch.set(material.root_epoch, {
    epoch: material.root_epoch,
    key: material.community_root,
    ...epochFields(material),
  });
  return [...byEpoch.values()].sort((a, b) => a.epoch - b.epoch);
}

/**
 * The ordered chain of epochs this material holds: every retained `held_roots`
 * entry plus the current root, oldest first. Each element carries that epoch's
 * own root, refounder and split-control coordinate, so older epochs derive the
 * control address they were actually published under.
 */
export function buildChain(material: JoinMaterial): JoinMaterial[] {
  const entries = chainEntries(material);
  const base = { ...material };
  delete base.refounder;
  delete base.control_pk;
  delete base.control_root;
  delete base.prev_root;
  return entries.map((r) => ({
    ...base,
    community_root: r.key,
    root_epoch: r.epoch,
    ...epochFields(r),
    held_roots: entries
      .filter((o) => o.epoch < r.epoch)
      .map((o) => ({
        epoch: o.epoch,
        key: o.key,
        ...epochFields(o),
        ...(o.retired_at !== undefined ? { retired_at: o.retired_at } : {}),
      }))
      .reverse(),
  }));
}

export type GenerationKeys = { keys: ConcordKeys; error?: never } | { keys?: never; error: string };

/** Keep results aligned with held generations when a coordinate is invalid. */
export function deriveGenerationKeys(material: JoinMaterial): GenerationKeys[] {
  let prior: ConcordKeys | undefined;
  return buildChain(material).map((m) => {
    try {
      const keys = deriveConcordKeys(m, [], prior);
      prior = keys;
      return { keys };
    } catch (e) {
      prior = undefined;
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
}

/** One held generation, as shown in the debug table (no secrets). */
export type GenerationRow = {
  epoch: number;
  rootFingerprint: string;
  refounder?: string;
  /** Unix seconds the previous epoch's key retired, i.e. when this one took over. */
  activeFrom?: number;
  /** Unix seconds this epoch's key retired; absent for the current epoch. */
  retiredAt?: number;
  controlPk?: string;
  current: boolean;
  /** True when the epoch directly before this one is not held. */
  gapBefore: boolean;
};

export function generationRows(material: JoinMaterial): GenerationRow[] {
  const entries = chainEntries(material);
  return entries.map((e, i) => {
    const prev = entries[i - 1];
    const gapBefore = i === 0 ? e.epoch !== 0 : e.epoch !== prev.epoch + 1;
    return {
      epoch: e.epoch,
      rootFingerprint: fingerprint(e.key),
      refounder: e.refounder,
      // Only the directly preceding epoch's retirement marks when this one began.
      activeFrom: gapBefore ? undefined : prev?.retired_at,
      retiredAt: e.retired_at,
      controlPk: e.control_pk,
      current: e.epoch === material.root_epoch,
      gapBefore,
    };
  });
}

export function diffMembers(prev: ReadonlySet<string> | undefined, cur: ReadonlySet<string>): { added: string[]; removed: string[] } {
  if (!prev) return { added: [], removed: [] };
  return {
    added: [...cur].filter((m) => !prev.has(m)),
    removed: [...prev].filter((m) => !cur.has(m)),
  };
}

// ---- relay fetches ---------------------------------------------------------

export function relaysFor(material: JoinMaterial): string[] {
  return material.relays.length ? material.relays : STOCK_RELAYS;
}

function wrapRequest(pool: RelayPool, relays: string[], authors: string[], signers: StreamSigners) {
  return firstValueFrom(
    pool
      .request(relays, [{ kinds: [GIFT_WRAP_KIND, EPHEMERAL_GIFT_WRAP_KIND], authors }], {
        waitForAuth: authors,
        onAuthRequired: signers.onAuthRequired,
      })
      .pipe(toArray(), timeout(10_000)),
  );
}

/** One-shot fetch of every gift wrap at `authors`, failing explicitly if the request has not completed within 10s. */
export async function fetchWraps(pool: RelayPool, relays: string[], authors: string[], signers: StreamSigners): Promise<NostrEvent[]> {
  if (authors.length === 0) return [];
  return wrapRequest(pool, relays, authors, signers);
}

export type RelayFetch = { ok: true; events: NostrEvent[] } | { ok: false; error: string };

/** Fetch `authors` from each relay separately, so presence can be reported per relay. */
export async function fetchWrapsPerRelay(
  pool: RelayPool,
  relays: string[],
  authors: string[],
  signers: StreamSigners,
): Promise<Map<string, RelayFetch>> {
  const settled = await Promise.allSettled(relays.map((r) => (authors.length ? wrapRequest(pool, [r], authors, signers) : Promise.resolve([]))));
  const out = new Map<string, RelayFetch>();
  settled.forEach((s, i) => {
    out.set(
      relays[i],
      s.status === "fulfilled"
        ? { ok: true, events: s.value }
        : { ok: false, error: s.reason instanceof Error ? s.reason.message || s.reason.name : String(s.reason) },
    );
  });
  return out;
}

// ---- rotation analysis -----------------------------------------------------

export type RotationAudit = {
  candidateId: string;
  rotator: string;
  newEpoch: number;
  prevEpoch: number;
  chunkCount: number;
  chunksHeld: number[];
  missingIndexes: number[];
  consistent: boolean;
  inconsistencies: string[];
  complete: boolean;
  vac?: [string, string, string];
  /** Earliest chunk millisecond stamp: when the rotation was published. */
  firstMs: number;
  /** Total per-recipient blobs across held chunks. */
  blobCount: number;
  /** relay → chunk indexes that relay returned. */
  chunksByRelay: Map<string, number[]>;
  /** Members (of the epoch being left) that hold a blob in this rotation. */
  rekeyed: string[];
  /** Members (of the epoch being left) with no blob: removed, or missed. */
  notRekeyed: string[];
};

export type MalformedRekey = { wrapId: string; reason: RekeyParseReason };

/**
 * Parse and group rekey events into candidate rotations, then check which of
 * `members` each candidate delivered a key to. `wrapRelays` maps a wrap id to the
 * relays that returned it (empty when unknown).
 */
export function analyzeRotations(
  rekeyEvents: DecodedEvent[],
  members: Iterable<string>,
  wrapRelays: Map<string, Set<string>> = new Map(),
): { rotations: RotationAudit[]; malformed: MalformedRekey[] } {
  const parsed: ParsedRekey[] = [];
  const malformed: MalformedRekey[] = [];
  for (const d of rekeyEvents) {
    const r = parseRekeyResult(d);
    if (r.kind === "parsed") parsed.push(r.value);
    else malformed.push({ wrapId: d.wrapId, reason: r.reason });
  }
  const memberList = [...members];
  const rotations = groupRotations(parsed)
    .filter((set) => set.scopeIdHex === ROOT_SCOPE_HEX)
    .map((set): RotationAudit => {
      const chunks = [...set.chunks.values()];
      const locators = new Set(chunks.flatMap((c) => c.blobs.map((b) => b.locator)));
      const rekeyed: string[] = [];
      const notRekeyed: string[] = [];
      for (const m of memberList) {
        (locators.has(rekeyLocator(set.rotator, m, set.scopeIdHex, set.newEpoch)) ? rekeyed : notRekeyed).push(m);
      }
      const chunksByRelay = new Map<string, number[]>();
      for (const c of chunks) {
        for (const relay of wrapRelays.get(c.wrapId) ?? []) {
          chunksByRelay.set(relay, [...(chunksByRelay.get(relay) ?? []), c.chunkIndex].sort((a, b) => a - b));
        }
      }
      return {
        candidateId: set.candidateId,
        rotator: set.rotator,
        newEpoch: Number(set.newEpoch),
        prevEpoch: Number(set.prevEpoch),
        chunkCount: set.chunkCount,
        chunksHeld: [...set.chunks.keys()].sort((a, b) => a - b),
        missingIndexes: set.missingIndexes,
        consistent: set.consistent,
        inconsistencies: set.inconsistencies,
        complete: set.complete,
        vac: set.vac,
        firstMs: Math.min(...chunks.map((c) => c.ms)),
        blobCount: chunks.reduce((n, c) => n + c.blobs.length, 0),
        chunksByRelay,
        rekeyed,
        notRekeyed,
      };
    })
    .sort((a, b) => a.firstMs - b.firstMs);
  return { rotations, malformed };
}

// ---- epoch audit -----------------------------------------------------------

export type AuditPlane = "control" | "guestbook" | "rekey";
export const AUDIT_PLANES: AuditPlane[] = ["control", "guestbook", "rekey"];

export type RelayPlaneCounts = { ok: true; counts: Record<AuditPlane, number> } | { ok: false; error: string };

export type EpochAudit = {
  epoch: number;
  keys: ConcordKeys;
  addresses: Record<AuditPlane, string>;
  relays: Map<string, RelayPlaneCounts>;
  /** Distinct decodable events per plane across every relay. */
  totals: Record<AuditPlane, number>;
  /** Wraps returned that failed to decode under this epoch's keys. */
  undecodable: number;
  state: CommunityState;
  rotations: RotationAudit[];
  malformed: MalformedRekey[];
};

/**
 * Audit one held epoch on every relay: fetch its control, guestbook and next-epoch
 * rekey addresses per relay, fold the members present at that epoch from the
 * Guestbook and control authors, and analyse the rotation(s) that left it.
 * `prior` threads the previous epoch's keys (mirrors `rollForward`).
 */
export async function auditEpoch(
  pool: RelayPool,
  epochMaterial: JoinMaterial,
  prior: ConcordKeys | undefined,
  relays: string[],
): Promise<EpochAudit> {
  const keys = deriveConcordKeys(epochMaterial, [], prior);
  const signers = new StreamSigners();
  signers.register([...(keys.control.signing ? [keys.control.signing] : []), keys.guestbook, keys.nextBaseRekey.key]);

  const addresses: Record<AuditPlane, string> = {
    control: keys.control.pk,
    guestbook: keys.guestbook.pk,
    rekey: keys.nextBaseRekey.key.pk,
  };
  const planeOf = new Map<string, AuditPlane>(AUDIT_PLANES.map((p) => [addresses[p], p]));
  const perRelay = await fetchWrapsPerRelay(pool, relays, Object.values(addresses), signers);

  const union = new Map<string, NostrEvent>();
  const wrapRelays = new Map<string, Set<string>>();
  const relayCounts = new Map<string, RelayPlaneCounts>();
  for (const [relay, res] of perRelay) {
    if (!res.ok) {
      relayCounts.set(relay, res);
      continue;
    }
    const counts: Record<AuditPlane, number> = { control: 0, guestbook: 0, rekey: 0 };
    const seen = new Set<string>();
    for (const ev of res.events) {
      const plane = planeOf.get(ev.pubkey);
      if (!plane || seen.has(ev.id)) continue;
      seen.add(ev.id);
      counts[plane]++;
      union.set(ev.id, ev);
      if (!wrapRelays.has(ev.id)) wrapRelays.set(ev.id, new Set());
      wrapRelays.get(ev.id)!.add(relay);
    }
    relayCounts.set(relay, { ok: true, counts });
  }

  const decoded: Record<AuditPlane, DecodedEvent[]> = { control: [], guestbook: [], rekey: [] };
  let undecodable = 0;
  for (const ev of union.values()) {
    const plane = planeOf.get(ev.pubkey)!;
    const info = keys.planes.get(ev.pubkey);
    const d = info ? decodeWrap(ev, info.convKey) : null;
    if (d) decoded[plane].push(d);
    else undecodable++;
  }

  const state0 = foldControl(decoded.control, epochMaterial);
  const observed = new Map<string, number>();
  for (const d of [...decoded.control, ...decoded.guestbook]) {
    if (d.ms > (observed.get(d.author) ?? 0)) observed.set(d.author, d.ms);
  }
  const rolesMap = new Map<string, Role>(state0.roles.map((r) => [r.role_id, r]));
  const members = foldMembers(
    decoded.guestbook,
    observed,
    state0.banlist,
    (m) => resolveStanding(m, epochMaterial.owner, rolesMap, state0.grants),
    Date.now(),
    epochMaterial.refounder,
  );
  const state: CommunityState = { ...state0, members };
  const { rotations, malformed } = analyzeRotations(decoded.rekey, members, wrapRelays);

  return {
    epoch: epochMaterial.root_epoch,
    keys,
    addresses,
    relays: relayCounts,
    totals: { control: decoded.control.length, guestbook: decoded.guestbook.length, rekey: decoded.rekey.length },
    undecodable,
    state,
    rotations,
    malformed,
  };
}
