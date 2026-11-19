/**
 * Per-member explanation of the CORD-02 §5 membership fold, for the Debug view.
 * Replays the Guestbook (Joins, Leaves, Kicks, refounder Snapshots) the way
 * `foldMembers` does, but records every entry's outcome per subject — decisive,
 * superseded or ignored with a reason — and combines it with observed activity,
 * the Banlist and the roster. `foldPresent` is this replay's verdict; comparing it
 * with the SDK's `state.members` exposes fold divergences.
 */
import { isEphemeralKind } from "applesauce-core/helpers/event";
import { PERM, type CommunityState, type Rumor } from "@applesauce/concord";
import {
  canActOn,
  hasMalformedMs,
  isStaffPermissionMask,
  JOIN_LEAVE_KIND,
  JOIN_VERB,
  KICK_KIND,
  LEAVE_VERB,
  resolveStanding,
  rumorMs,
  SNAPSHOT_KIND,
  snapshotAuthorities,
  vacVerifier,
  type Standing,
} from "@applesauce/concord/helpers";

/** Guestbook kinds the membership fold reads: Join/Leave, Kick, Snapshot. */
export const GUESTBOOK_KINDS: ReadonlySet<number> = new Set([JOIN_LEAVE_KIND, KICK_KIND, SNAPSHOT_KIND]);

const ONE_HOUR_MS = 60 * 60 * 1000;
const HEX64 = /^[\da-fA-F]{64}$/;

export type GuestbookVerb = "join" | "leave" | "kick" | "snapshot";
export type IgnoreReason =
  | "banned author"
  | "malformed ms"
  | "future dated"
  | "unknown verb"
  | "target is owner"
  | "insufficient rank"
  | "vac rejected"
  | "not snapshot authority"
  | "malformed snapshot";

export type TraceEntry = {
  rumorId: string;
  verb: GuestbookVerb;
  /** Signer of the entry; for a Kick the kicker, for a Snapshot the refounder. */
  author: string;
  ms: number;
  present: boolean;
  outcome: "decisive" | "superseded" | "ignored";
  reason?: IgnoreReason;
  /** Members listed in a Snapshot. */
  size?: number;
};

export type ActivitySource = { label: string; count: number; lastMs: number };

export type MemberBasis =
  | "join"
  | "snapshot"
  | "activity"
  | "left"
  | "kicked"
  | "banned"
  | "stale pre-ban"
  | "no record";

export type MemberTrace = {
  pubkey: string;
  /** In the SDK's folded member set. */
  present: boolean;
  /** This replay's verdict. */
  foldPresent: boolean;
  basis: MemberBasis;
  /** The entry that decided the guestbook state, if any. */
  decisive?: TraceEntry;
  entries: TraceEntry[];
  lastActivityMs?: number;
  activity: ActivitySource[];
  banned: boolean;
  bannedAtMs?: number;
  owner: boolean;
  standing: Standing;
  staff: boolean;
  /** Role ids of the newest verified Grant edition; undefined when none is verified. */
  verifiedRoleIds?: string[];
  grantUnverified: boolean;
};

export type ActivityInput = { label: string; rumors: readonly Rumor[] };

/** Latest non-ephemeral activity per author, per source and overall. */
export function foldActivity(sources: readonly ActivityInput[]): Map<string, { lastMs: number; sources: ActivitySource[] }> {
  const out = new Map<string, { lastMs: number; sources: ActivitySource[] }>();
  for (const { label, rumors } of sources) {
    for (const r of rumors) {
      if (isEphemeralKind(r.kind)) continue;
      const ms = rumorMs(r);
      let a = out.get(r.pubkey);
      if (!a) out.set(r.pubkey, (a = { lastMs: 0, sources: [] }));
      let s = a.sources.find((x) => x.label === label);
      if (!s) a.sources.push((s = { label, count: 0, lastMs: 0 }));
      s.count++;
      if (ms > s.lastMs) s.lastMs = ms;
      if (ms > a.lastMs) a.lastMs = ms;
    }
  }
  return out;
}

export function traceMembers(
  state: CommunityState,
  guestbook: readonly Rumor[],
  activity: ReadonlyMap<string, { lastMs: number; sources: ActivitySource[] }>,
  nowMs = Date.now(),
): MemberTrace[] {
  const material = state.material;
  const roles = new Map(state.roles.map((r) => [r.role_id, r]));
  const standingOf = (pk: string) => resolveStanding(pk, material.owner, roles, state.grants);
  const verifyVac = vacVerifier(state, PERM.KICK);
  const authorities = snapshotAuthorities(material);
  const bannedAt = state.bannedAt;

  const entries = new Map<string, TraceEntry[]>();
  const winner = new Map<string, TraceEntry & { snapshot: boolean }>();
  const push = (subject: string, e: TraceEntry) => {
    const list = entries.get(subject);
    if (list) list.push(e);
    else entries.set(subject, [e]);
  };
  const consider = (subject: string, e: TraceEntry, snapshot: boolean) => {
    push(subject, e);
    if (e.outcome === "ignored") return;
    const prev = winner.get(subject);
    const wins = snapshot
      ? !prev || e.ms > prev.ms
      : !prev || e.ms > prev.ms || (e.ms === prev.ms && (prev.snapshot || e.rumorId < prev.rumorId));
    if (wins) winner.set(subject, Object.assign(e, { snapshot }));
  };

  for (const r of guestbook) {
    const ms = rumorMs(r);
    const base = { rumorId: r.id, author: r.pubkey, ms, outcome: "superseded" as TraceEntry["outcome"] };
    const authorBanned = state.banlist.has(r.pubkey) && !standingOf(r.pubkey).isOwner;
    const timeIssue: IgnoreReason | undefined = hasMalformedMs(r) ? "malformed ms" : ms > nowMs + ONE_HOUR_MS ? "future dated" : undefined;

    if (r.kind === JOIN_LEAVE_KIND) {
      const verb = typeof r.content === "string" ? r.content.trim() : "";
      const present = verb === JOIN_VERB;
      const reason: IgnoreReason | undefined = authorBanned ? "banned author" : verb !== JOIN_VERB && verb !== LEAVE_VERB ? "unknown verb" : timeIssue;
      consider(r.pubkey, { ...base, verb: present ? "join" : "leave", present, ...(reason ? { outcome: "ignored", reason } : {}) }, false);
    } else if (r.kind === KICK_KIND) {
      const target = r.tags.find((t) => t[0] === "p")?.[1];
      if (!target) continue;
      let reason: IgnoreReason | undefined = authorBanned ? "banned author" : undefined;
      if (!reason) {
        const actor = standingOf(r.pubkey);
        const victim = standingOf(target);
        if (victim.isOwner) reason = "target is owner";
        else if (!canActOn(actor, victim, PERM.KICK)) reason = "insufficient rank";
        else {
          const t = r.tags.find((x) => x[0] === "vac");
          const vac = t && t[1] && t[2] && t[3] ? ([t[1], t[2], t[3]] as [string, string, string]) : undefined;
          if (!verifyVac(r.pubkey, vac, target)) reason = "vac rejected";
        }
      }
      reason ??= timeIssue;
      consider(target, { ...base, verb: "kick", present: false, ...(reason ? { outcome: "ignored", reason } : {}) }, false);
    } else if (r.kind === SNAPSHOT_KIND) {
      let listed: string[] = [];
      let malformed = false;
      try {
        const parsed: unknown = JSON.parse(r.content);
        if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) listed = parsed.filter((p) => HEX64.test(p)).map((p) => p.toLowerCase());
        else malformed = true;
      } catch {
        malformed = true;
      }
      const reason: IgnoreReason | undefined = authorBanned
        ? "banned author"
        : !authorities.has(r.pubkey)
          ? "not snapshot authority"
          : (timeIssue ?? (malformed ? "malformed snapshot" : undefined));
      for (const pk of listed) {
        consider(pk, { ...base, verb: "snapshot", present: true, size: listed.length, ...(reason ? { outcome: "ignored", reason } : {}) }, true);
      }
    }
  }
  for (const w of winner.values()) w.outcome = "decisive";

  const cv = state.controlVerification;
  const verifiedGrants = new Map<string, string[]>();
  cv?.grantHistory.forEach((editions) => {
    const last = editions[editions.length - 1];
    if (last) verifiedGrants.set(last.member, [...last.roleIds]);
  });

  const everyone = new Set<string>([material.owner, ...state.members, ...entries.keys(), ...activity.keys(), ...state.grants.keys(), ...state.banlist]);
  const sameSet = (a: string[] = [], b: string[] = []) => a.length === b.length && a.every((x) => b.includes(x));

  return [...everyone].map((pk) => {
    const standing = standingOf(pk);
    const owner = standing.isOwner;
    const banned = state.banlist.has(pk) && !owner;
    const banAt = bannedAt?.get(pk);
    const stale = (ms: number) => banAt !== undefined && ms <= banAt * 1000;
    const decisive = winner.get(pk);
    const act = activity.get(pk);
    const viaGuestbook = !!decisive?.present && !stale(decisive.ms);
    const viaActivity = !!act && !stale(act.lastMs) && (!decisive || decisive.present || act.lastMs > decisive.ms);
    const foldPresent = !banned && (viaGuestbook || viaActivity);

    let basis: MemberBasis;
    if (banned) basis = "banned";
    else if (viaGuestbook) basis = decisive!.verb === "snapshot" ? "snapshot" : "join";
    else if (viaActivity) basis = "activity";
    else if ((decisive && stale(decisive.ms)) || (act && stale(act.lastMs))) basis = decisive && !decisive.present ? (decisive.verb === "kick" ? "kicked" : "left") : "stale pre-ban";
    else if (decisive?.verb === "kick") basis = "kicked";
    else if (decisive && !decisive.present) basis = "left";
    else basis = "no record";

    const verifiedRoleIds = verifiedGrants.get(pk);
    const displayRoles = state.grants.get(pk) ?? [];
    return {
      pubkey: pk,
      present: state.members.has(pk),
      foldPresent,
      basis,
      decisive,
      entries: (entries.get(pk) ?? []).sort((a, b) => a.ms - b.ms),
      lastActivityMs: act?.lastMs,
      activity: act?.sources ?? [],
      banned,
      bannedAtMs: banAt !== undefined ? banAt * 1000 : undefined,
      owner,
      standing,
      staff: owner || isStaffPermissionMask(standing.permissions),
      verifiedRoleIds,
      grantUnverified: !owner && displayRoles.length > 0 && !!cv && !sameSet(displayRoles, verifiedRoleIds),
    };
  });
}
