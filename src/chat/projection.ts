import { auditTime, combineLatest, distinctUntilChanged, map, shareReplay, type Observable } from "rxjs";
import type { ConcordCommunity } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { EDIT_KIND } from "@applesauce/concord/helpers";
import { foldChannel, type ChannelProjection } from "./fold";

const projections = new WeakMap<ConcordCommunity, Map<string, Observable<ChannelProjection>>>();

/** Share one fold per active channel across chat, threads, badges and mentions.
 * refCount releases store subscriptions and replayed history after the last consumer leaves.
 */
export function channelProjection(community: ConcordCommunity, channelId: string): Observable<ChannelProjection> {
  let channels = projections.get(community);
  if (!channels) {
    channels = new Map();
    projections.set(community, channels);
  }
  let projection = channels.get(channelId);
  if (!projection) {
    // Authority verification can change without a role/grant slice changing.
    // Select only authority inputs rather than folding again on member presence.
    const authority = community.state$.pipe(
      map((s) => [s.roles, s.grants, s.banlist, s.material, s.controlVerification] as const),
      distinctUntilChanged((a, b) => a.every((value, i) => value === b[i])),
    );
    projection = combineLatest([
      community.channelTimeline(channelId, [{ kinds: [9, 7, 5, EDIT_KIND, 1111] }]),
      authority,
    ]).pipe(
      // Hydration and authority updates can emit synchronously many times.
      // Fold the settled snapshot once per task, including both ban and authority changes.
      auditTime(0),
      map(([rumors]) => foldChannel(rumors, (deleter, author) => deleter === author ||
        community.admin.hasPerm(deleter, PERM.MANAGE_MESSAGES, community.standingOf(author).position))),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    channels.set(channelId, projection);
  }
  return projection;
}
