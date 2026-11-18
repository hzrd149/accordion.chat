import type { MediaAttachment } from "@applesauce/concord/helpers";

/** In-memory identity includes every input to the verified media read. Never
 * log or persist this value: like the attachment itself, it contains secrets. */
export function attachmentIdentity(attachment: MediaAttachment): string {
  return JSON.stringify([
    attachment.url, attachment.type, attachment.sha256, attachment.originalSha256,
    attachment.encryption?.algorithm, attachment.encryption?.key, attachment.encryption?.nonce,
    attachment.encryptionError !== undefined,
  ]);
}
