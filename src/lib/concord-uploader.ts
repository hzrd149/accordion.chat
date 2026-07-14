// Adapts the app's Blossom media pipeline (encrypt → upload ciphertext) to the
// `ConcordUploader` interface applesauce-concord's ConcordCommunity calls when
// sending file attachments or setting a community icon/banner. The core client
// carries no Blossom dependency; we supply the encryption + upload here.
//
// The returned `MediaAttachment` uses applesauce-common's field names (`type`,
// `originalSha256`) and the `encryption` block ConcordCommunity re-reads to build
// the NIP-92 imeta media-encryption tags / a community `BlobPointer`.

import type { ISigner } from "applesauce-signers";
import type { Storage } from "applesauce-concord";
import type { MediaAttachment } from "applesauce-concord/helpers";
import { castUser } from "applesauce-core";
import { BehaviorSubject } from "rxjs";
import { encryptImageBlob } from "./image";
import { DEFAULT_BLOSSOM_SERVERS, dedupeServers, uploadBlob } from "./blossom";
import { eventStore } from "../nostr";

type ConcordUploader = Storage.ConcordUploader;

export type UploadProgress = {
  /** Files in this burst. */
  total: number;
  /** Files fully uploaded so far, so the file being worked on is `done + 1`. */
  done: number;
  /** Which half of the current file's trip we're in. */
  phase: "encrypting" | "uploading";
};

/**
 * Attachment progress for the burst that's currently in flight, or null when idle.
 *
 * `ConcordCommunity.sendMessage` awaits the whole encrypt→upload→publish chain
 * behind a single promise, so a composer can't tell "sealing a 40MB video" from
 * "waiting on a relay". This surfaces the media half of that chain.
 *
 * The burst is opened by the caller rather than inferred here, because
 * `sendMessage` uploads files one at a time: an in-flight counter would fall to
 * zero between files and report each one as its own burst of one.
 *
 * Module state is safe: the uploader is built once per account (see context.tsx)
 * and only the channel composer sends attachments — thread replies are text-only.
 */
export const uploadProgress$ = new BehaviorSubject<UploadProgress | null>(null);

let burst: UploadProgress | null = null;

/** Open a burst of `total` files. Returns the closer; call it in a `finally`. */
export function beginUploadBurst(total: number): () => void {
  burst = { total, done: 0, phase: "encrypting" };
  uploadProgress$.next({ ...burst });
  return () => {
    burst = null;
    uploadProgress$.next(null);
  };
}

function step(phase: UploadProgress["phase"]) {
  if (!burst) return;
  burst = { ...burst, phase };
  uploadProgress$.next(burst);
}

/** Mark the current file finished; `done === total` means the publish is all that's left. */
function complete() {
  if (!burst) return;
  burst = { ...burst, done: burst.done + 1 };
  uploadProgress$.next(burst);
}

/**
 * Build a ConcordUploader over the app's Blossom pipeline.
 *
 * @param signer      the logged-in user's signer (signs the kind-24242 upload auth)
 * @param pubkey      the user's hex pubkey (for the kind-10063 server-list fallback)
 * @param getCommunityServers  resolves a community's own `blossom_servers`, if any
 */
export function createConcordUploader(
  signer: ISigner,
  pubkey: string,
  getCommunityServers: (communityId: string) => string[] | undefined,
): ConcordUploader {
  return {
    async upload(file: Blob, communityId: string): Promise<MediaAttachment> {
      step("encrypting");
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
      const servers = await resolveServers(communityId, pubkey, getCommunityServers);
      step("uploading");
      const url = await uploadBlob(ciphertext, servers, signer);
      complete();
      return {
        url,
        type: file.type || undefined,
        originalSha256: hash,
        encryption: { algorithm: "aes-gcm", key, nonce },
      };
    },
  };
}

/**
 * Blossom servers to upload to: the community's own list if it defines one,
 * otherwise the user's kind-10063 list (read reactively via applesauce's `User`
 * cast — the loader wired in nostr.ts resolves it on a cold store), falling back
 * to the app defaults only if neither exists.
 */
async function resolveServers(
  communityId: string,
  pubkey: string,
  getCommunityServers: (communityId: string) => string[] | undefined,
): Promise<string[]> {
  const communityServers = getCommunityServers(communityId) ?? [];
  if (communityServers.length) return dedupeServers(communityServers);

  const urls = await castUser(pubkey, eventStore)
    .blossomServers$.$first(3000)
    .catch(() => undefined as URL[] | undefined);
  const userServers = (urls ?? []).map((u) => u.toString());
  if (userServers.length) return dedupeServers(userServers);

  return DEFAULT_BLOSSOM_SERVERS;
}
