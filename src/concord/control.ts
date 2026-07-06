// CORD-04 Control Plane — folding versioned editions into community state.
//
// Every authority action is a kind 3308 edition sealed by the actor's real
// npub. Clients fold the highest-version edition per entity, refuse downgrades,
// and drop editions whose signer isn't authorised. Authority is rooted at the
// owner (proven by community_id) and resolved outward, so the roster is folded
// owner-first to break the apparent circularity (CORD-04 §1).

import { PERM, VSK } from "./types";
import type {
  ChannelMetadata,
  CommunityMetadata,
  CommunityState,
  DecodedEvent,
  Grant,
  JoinMaterial,
  Role,
} from "./types";
import { canActOn, hasPerm, resolveStanding } from "./permissions";

interface Edition {
  vsk: number;
  eid: string;
  version: number;
  prev?: string;
  content: string;
  author: string;
  rumorId: string;
  ms: number;
}

function parseEdition(d: DecodedEvent): Edition | null {
  const r = d.rumor;
  const get = (name: string) => r.tags.find((t) => t[0] === name)?.[1];
  const vsk = get("vsk");
  const eid = get("eid");
  if (vsk === undefined || eid === undefined) return null;
  const ev = get("ev");
  return {
    vsk: parseInt(vsk, 10),
    eid,
    version: ev ? parseInt(ev, 10) : 1,
    prev: get("ep"),
    content: r.content,
    author: d.author,
    rumorId: r.id,
    ms: d.ms,
  };
}

/** Order two editions of the same entity: higher version wins, then lower id. */
function better(a: Edition, b: Edition): Edition {
  if (a.version !== b.version) return a.version > b.version ? a : b;
  return a.rumorId < b.rumorId ? a : b;
}

/** Group editions by eid and return, per eid, candidates sorted best-first. */
function groupByEntity(editions: Edition[]): Map<string, Edition[]> {
  const byEid = new Map<string, Edition[]>();
  for (const e of editions) {
    const arr = byEid.get(e.eid) ?? [];
    arr.push(e);
    byEid.set(e.eid, arr);
  }
  for (const arr of byEid.values()) arr.sort((a, b) => (better(a, b) === a ? -1 : 1));
  return byEid;
}

export function foldControl(events: DecodedEvent[], material: JoinMaterial): CommunityState {
  const editions = events
    .map(parseEdition)
    .filter((e): e is Edition => e !== null);

  const byVsk = (vsk: number) => editions.filter((e) => e.vsk === vsk);

  const roleCandidates = groupByEntity(byVsk(VSK.ROLE));
  const grantCandidates = groupByEntity(byVsk(VSK.GRANT));

  // ---- Fold the roster owner-first, iterating to a fixpoint (CORD-04 §1). --
  const roles = new Map<string, Role>();
  const grants = new Map<string, string[]>();
  const owner = material.owner;

  const standing = (member: string) => resolveStanding(member, owner, roles, grants);

  for (let pass = 0; pass < 4; pass++) {
    let changed = false;

    // Roles: signer needs MANAGE_ROLES and may not mint a position at/above self.
    for (const [eid, cands] of roleCandidates) {
      for (const cand of cands) {
        const s = standing(cand.author);
        if (!s.isOwner && !hasPerm(s.permissions, PERM.MANAGE_ROLES)) continue;
        let role: Role;
        try {
          role = JSON.parse(cand.content) as Role;
        } catch {
          continue;
        }
        if (!role.role_id) role.role_id = eid;
        // No edition may claim a position at or above its own signer.
        if (!s.isOwner && role.position <= s.position) continue;
        if (role.position <= 0) continue; // position 0 is the owner alone
        const prev = roles.get(eid);
        if (!prev || prev.position !== role.position || prev.name !== role.name) changed = true;
        roles.set(eid, role);
        break;
      }
    }

    // Grants: signer must outrank every role handed out and hold MANAGE_ROLES.
    for (const [, cands] of grantCandidates) {
      for (const cand of cands) {
        const s = standing(cand.author);
        let grant: Grant;
        try {
          grant = JSON.parse(cand.content) as Grant;
        } catch {
          continue;
        }
        if (!grant.member) continue;
        const authorized =
          s.isOwner ||
          (hasPerm(s.permissions, PERM.MANAGE_ROLES) &&
            grant.role_ids.every((rid) => {
              const r = roles.get(rid);
              return r ? r.position > s.position : false;
            }));
        if (!authorized) continue;
        const prevRoles = grants.get(grant.member) ?? [];
        if (prevRoles.join(",") !== grant.role_ids.join(",")) changed = true;
        grants.set(grant.member, grant.role_ids);
        break;
      }
    }

    if (!changed) break;
  }

  // ---- Metadata (MANAGE_METADATA) -----------------------------------------
  let metadata: CommunityMetadata | undefined;
  for (const cand of groupByEntity(byVsk(VSK.METADATA)).get(material.community_id) ?? []) {
    const s = standing(cand.author);
    if (!s.isOwner && !hasPerm(s.permissions, PERM.MANAGE_METADATA)) continue;
    try {
      metadata = JSON.parse(cand.content) as CommunityMetadata;
      break;
    } catch {
      /* skip */
    }
  }

  // ---- Channels (MANAGE_CHANNELS) -----------------------------------------
  const channels: ChannelMetadata[] = [];
  for (const [eid, cands] of groupByEntity(byVsk(VSK.CHANNEL))) {
    for (const cand of cands) {
      const s = standing(cand.author);
      if (!s.isOwner && !hasPerm(s.permissions, PERM.MANAGE_CHANNELS)) continue;
      try {
        const meta = JSON.parse(cand.content) as ChannelMetadata;
        meta.channel_id = eid;
        // Carry any client-known key material for this channel from the invite.
        const known = material.channels.find((c) => c.id === eid);
        if (known) {
          meta.key = known.key;
          meta.epoch = known.epoch;
        }
        if (!meta.deleted) channels.push(meta);
        break;
      } catch {
        /* skip */
      }
    }
  }

  // ---- Banlist (BAN) ------------------------------------------------------
  const banlist = new Set<string>();
  for (const cand of groupByEntity(byVsk(VSK.BANLIST)).values().next().value ?? []) {
    const s = standing((cand as Edition).author);
    if (!s.isOwner && !hasPerm(s.permissions, PERM.BAN)) continue;
    try {
      for (const pk of JSON.parse((cand as Edition).content) as string[]) banlist.add(pk);
      break;
    } catch {
      /* skip */
    }
  }

  return {
    material,
    metadata,
    channels,
    roles: [...roles.values()].sort((a, b) => a.position - b.position || (a.role_id < b.role_id ? -1 : 1)),
    grants,
    banlist,
    members: new Set(),
    dissolved: false,
  };
}

export { resolveStanding, canActOn };
