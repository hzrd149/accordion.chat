// Chat actions that don't map 1:1 onto a ConcordCommunity method.
//
// The SDK handles kind-9-rooted nested threads. Only replies carrying custom emoji
// need CommentFactory, since replyToThread currently accepts text alone.
//
// `sendEditWithEmojis` builds a kind-3302 edit rumor with NIP-30 `emoji` tags
// (ConcordCommunity.editMessage doesn't accept emojis, so we chain
// `includeEmojis` onto EditFactory app-side and publish via `sendEvent`).

import { CommentFactory } from "applesauce-common/factories";
import { EditFactory } from "@applesauce/concord/factories";
import { includeEmojis } from "applesauce-core/operations";
import type { Emoji } from "applesauce-common/helpers";
import type { ConcordCommunity } from "@applesauce/concord";

export async function sendThreadReply(
  community: ConcordCommunity,
  channelId: string,
  parent: { id: string; author: string; kind: number },
  text: string,
  emojis?: Emoji[],
): Promise<void> {
  const parentEvent = await community.channelStore(channelId).getEvent(parent.id);
  if (!parentEvent) throw new Error("Reply target is not loaded");
  if (!emojis?.some((emoji) => text.includes(`:${emoji.shortcode}:`))) {
    await community.replyToThread(channelId, parentEvent, text);
    return;
  }
  await community.sendEvent(channelId, CommentFactory.reply(parentEvent, text, { emojis }), {});
}

export async function sendEditWithEmojis(
  community: ConcordCommunity | undefined,
  channelId: string,
  targetId: string,
  text: string,
  emojis?: Emoji[],
): Promise<void> {
  if (!community) return;
  const template = await EditFactory.create(targetId, text);
  const withEmojis = emojis?.length ? includeEmojis(emojis)(template) : template;
  await community.sendEvent(channelId, withEmojis);
}
