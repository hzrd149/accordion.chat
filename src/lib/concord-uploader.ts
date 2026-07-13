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
import { encryptImageBlob } from "./image";
import { DEFAULT_BLOSSOM_SERVERS, dedupeServers, uploadBlob } from "./blossom";
import { eventStore } from "../nostr";

type ConcordUploader = Storage.ConcordUploader;

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
      const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
      const servers = await resolveServers(communityId, pubkey, getCommunityServers);
      const url = await uploadBlob(ciphertext, servers, signer);
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
