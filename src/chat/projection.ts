import { auditTime, combineLatest, distinctUntilChanged, map, of, scan, shareReplay, switchMap, type Observable } from "rxjs";
import type { ConcordChannelMessage, ConcordCommunity } from "@applesauce/concord";
import type { Rumor } from "applesauce-core/helpers";
import { foldChannel, type ChannelProjection } from "./fold";

const projections = new WeakMap<ConcordCommunity, Map<string, Observable<ChannelProjection>>>();

// SDK message wrappers/arrays can be rebuilt when unrelated plane inputs change.
// Compare the actual presentation inputs before allocating another full fold.
function sameInputs(
  [messages, effects]: readonly [readonly ConcordChannelMessage[], readonly Rumor[]],
  [nextMessages, nextEffects]: readonly [readonly ConcordChannelMessage[], readonly Rumor[]],
): boolean {
  return messages.length === nextMessages.length && effects.length === nextEffects.length &&
    messages.every((message, index) => {
      const next = nextMessages[index];
      return message.rumor === next.rumor && message.edit === next.edit && message.content === next.content;
    }) && effects.every((effect, index) => effect === nextEffects[index]);
}

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
      distinctUntilChanged(sameInputs),
      scan((previous: ChannelProjection, [messages, effects]) => foldChannel(messages, effects, previous),
        { messages: [], threads: new Map() }),
      distinctUntilChanged(),
      shareReplay({ bufferSize: 1, refCount: true }),
    );
    channels.set(channelId, projection);
  }
  return projection;
}
