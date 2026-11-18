// Chat actions that don't map 1:1 onto a ConcordCommunity method.
//
// Replies with attachments or custom emoji use CommentFactory because
// the SDK convenience method accepts text alone.
//
// `sendEditWithEmojis` builds a kind-3302 edit rumor with NIP-30 `emoji` tags
// (ConcordCommunity.editMessage doesn't accept emojis, so we chain
// `includeEmojis` onto EditFactory app-side and publish via `sendEvent`).

import type { EventTemplate } from "nostr-tools";
import { CommentFactory } from "applesauce-common/factories";
import { EditFactory } from "@applesauce/concord/factories";
import { includeEmojis } from "applesauce-core/operations";
import type { Emoji } from "applesauce-common/helpers";
import { MissingChannelKeyError, type ConcordCommunity, type Media } from "@applesauce/concord";
import { hasChannelKey, type MediaAttachment } from "@applesauce/concord/helpers";
import { includeMediaEncryption, type MediaEncryption } from "@applesauce/concord/operations";
import { MediaAttachment as MediaAttachmentOperations } from "applesauce-common/operations";

export async function sendThreadReply(
  community: ConcordCommunity,
  channelId: string,
  parent: { id: string; author: string; kind: number },
  text: string,
  emojis?: Emoji[],
  media?: {
    files: readonly File[];
    uploader: Media.ConcordUploader;
    onProgress: (progress: Media.ConcordUploadProgress) => void;
  },
): Promise<void> {
  const parentEvent = await community.channelStore(channelId).getEvent(parent.id);
  if (!parentEvent) throw new Error("Reply target is not loaded");
  if (!media?.files.length && !emojis?.some((emoji) => text.includes(`:${emoji.shortcode}:`))) {
    await community.replyToThread(channelId, parentEvent, text);
    return;
  }
  const attachments: MediaAttachment[] = [];
  const encryption: MediaEncryption[] = [];
  if (media?.files.length) {
    const channel = community.state$.value.channels.find((entry) => entry.channel_id === channelId);
    if (!channel) throw new Error("The channel is unavailable");
    if (channel.private && !hasChannelKey(community.material, channelId)) throw new MissingChannelKeyError(channelId);
    const total = media.files.length;
    for (const [index, file] of media.files.entries()) {
      media.onProgress({ total, done: index, phase: "encrypting" });
      const attachment = await media.uploader.upload(file, community.communityId, {
        onProgress: (phase) => media.onProgress({ total, done: index, phase }),
      });
      if (!attachment.url || !attachment.encryption) throw new Error("Could not prepare an encrypted attachment");
      attachments.push(attachment);
      encryption.push({ url: attachment.url, ...attachment.encryption });
      media.onProgress({ total, done: index + 1, phase: "uploading" });
    }
  }

  const content = [text, ...encryption.map(({ url }) => url)].filter(Boolean).join("\n");
  let comment: EventTemplate = await CommentFactory.reply(parentEvent, content, { emojis });
  if (attachments.length) {
    comment = await MediaAttachmentOperations.addMediaAttachments(attachments)(comment);
    comment = await includeMediaEncryption(encryption)(comment);
  }
  await community.sendEvent(channelId, comment, {});
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
