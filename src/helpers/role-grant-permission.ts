import type { ConcordCommunity } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { combineLatest, distinctUntilChanged, map, of, switchMap } from "rxjs";
import { roleRank } from "./roles";

/** A grant replaces the whole role set: every retained role must also be writable. */
export function canChangeMemberRole$(community: ConcordCommunity, member: string, roleId: string) {
  return combineLatest([community.roles$, community.grants$, community.dissolved$]).pipe(
    switchMap(([roles, grants, dissolved]) => {
      if (dissolved) return of(false);
      const held = grants.get(member) ?? [];
      const next = held.includes(roleId) ? held.filter((id) => id !== roleId) : [...held, roleId];
      const changed = roles.find((role) => role.role_id === roleId && !role.deleted);
      const retained = next.map((id) => roles.find((role) => role.role_id === id && !role.deleted));
      if (!changed || retained.some((role) => !role)) return of(false);
      return combineLatest([
        community.canModerate$(member, PERM.MANAGE_ROLES),
         community.can$(PERM.MANAGE_ROLES, roleRank(changed)),
         ...retained.map((role) => community.can$(PERM.MANAGE_ROLES, roleRank(role!))),
      ]).pipe(map((allowed) => allowed.every(Boolean)));
    }),
    distinctUntilChanged(),
  );
}

/** Channel membership actions may also update a channel-scoped Role Grant. */
export function channelMemberPermissions$(community: ConcordCommunity, channelId: string) {
  return combineLatest([community.members$, community.roles$, community.channelViews$, community.can$(PERM.MANAGE_CHANNELS), community.dissolved$]).pipe(
    switchMap(([members, roles, channels, canManage, dissolved]) => {
      const empty = { add: new Set<string>(), remove: new Set<string>() };
      if (dissolved || !canManage || !channels.some((ch) => ch.channel_id === channelId && ch.accessible)) return of(empty);
      const role = roles.find((r) => !r.deleted && r.scope?.kind === "channel" && r.scope.channel_id === channelId);
      const candidates = [...members];
      if (!candidates.length) return of(empty);
      return combineLatest(candidates.map((member) => combineLatest([
        role ? canChangeMemberRole$(community, member, role.role_id) : of(true),
        community.canModerate$(member, PERM.MANAGE_CHANNELS),
      ]).pipe(map(([grant, moderate]) => ({ member, grant, moderate }))))).pipe(
        map((permissions) => ({
          add: new Set(permissions.filter((p) => p.grant).map((p) => p.member)),
          remove: new Set(permissions.filter((p) => p.grant && p.moderate).map((p) => p.member)),
        })),
      );
    }),
  );
}
