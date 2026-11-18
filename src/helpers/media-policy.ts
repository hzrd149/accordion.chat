/** New uploads fit Concord's default 32 MiB ciphertext read limit. */
export const MAX_MEDIA_CIPHERTEXT_BYTES = 32 * 1024 * 1024;
export const AES_GCM_TAG_BYTES = 16;
export const MAX_MEDIA_UPLOAD_BYTES = MAX_MEDIA_CIPHERTEXT_BYTES - AES_GCM_TAG_BYTES;

/** v0.1 allowed unbounded uploads. Retain bounded playback for older large files,
 * without allowing newly uploaded files that other default SDK clients cannot read. */
export const MAX_ATTACHMENT_DOWNLOAD_BYTES = 128 * 1024 * 1024;

export function assertMediaUploadSize(file: Pick<Blob, "size">): void {
  if (file.size > MAX_MEDIA_UPLOAD_BYTES) {
    throw new Error(`Media is too large. Maximum file size is 32 MiB minus the 16-byte encryption tag (${MAX_MEDIA_UPLOAD_BYTES} bytes).`);
  }
}
