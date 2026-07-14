// Chat actions that don't map 1:1 onto a ConcordCommunity method.
//
// The app's threads are NIP-22 comment trees rooted on chat messages (kind 9),
// not the package's kind-11 forum threads — so `community.replyToThread` (which
// targets a ForumThread root) doesn't fit. We build the comment directly with
// applesauce's CommentFactory, passing the *full* parent rumor (looked up from the
// channel store) so NIP-22 root pointers propagate to nested replies, and let
// `community.sendEvent` apply the channel/epoch/ms binding + wrap + publish.

import { CommentFactory } from "applesauce-common/factories";
import type { Emoji } from "applesauce-common/helpers";
import type { ConcordCommunity } from "applesauce-concord";

export async function sendThreadReply(
  community: ConcordCommunity,
  channelId: string,
  parent: { id: string; author: string; kind: number },
  text: string,
  emojis?: Emoji[],
): Promise<void> {
  const parentEvent = await community.channelStore(channelId).getEvent(parent.id);
  const target = parentEvent ?? { type: "event" as const, id: parent.id, kind: parent.kind, pubkey: parent.author };
  await community.sendEvent(channelId, CommentFactory.reply(target, text, { emojis }), {});
}
