import { auditTime, combineLatest, distinctUntilChanged, map, of, shareReplay, switchMap, type Observable } from "rxjs";
import type { ConcordCommunity } from "@applesauce/concord";
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
    projection = community.channels$.pipe(
      map((handles) => handles.find((channel) => channel.id === channelId)),
      distinctUntilChanged(),
      switchMap((channel) => channel ? combineLatest([
        channel.messages$,
        channel.timeline$([{ kinds: [7, 5] }]),
      ]) : of([[], []] as const)),
      // Hydration and authority updates can emit synchronously many times.
      // Fold the settled snapshot once per task, including both ban and authority changes.
      auditTime(0),
      map(([messages, effects]) => foldChannel(messages, effects)),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    channels.set(channelId, projection);
  }
  return projection;
}
