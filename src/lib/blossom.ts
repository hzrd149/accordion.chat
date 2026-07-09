// Blossom blob upload, on top of `blossom-client-sdk`.
//
// Concord uploads only *ciphertext* blobs (see image.ts), so a media server
// never sees plaintext. The SDK handles the BUD-02/BUD-04 dance (upload to the
// first server, mirror to the rest, preflight HEAD checks); we supply the
// server list (community-defined or the user's own kind-10063 list) and a
// kind-24242 auth event signed by the user's own key.

import { Actions, createUploadAuth, type Signer as BlossomSigner } from "blossom-client-sdk";
import type { ISigner } from "applesauce-signers";

/**
 * Last-resort Blossom servers, used only when neither the community nor the
 * user has defined one. Order follows BUD-03's "most trusted first" convention.
 */
export const DEFAULT_BLOSSOM_SERVERS = ["https://blossom.primal.net/", "https://blossom.band/"];

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

/** Deduplicate a server list, preserving order (first occurrence wins). */
export function dedupeServers(servers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of servers) {
    const key = normalizeUrl(url);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(url);
    }
  }
  return out;
}

/**
 * Upload ciphertext bytes to the given Blossom servers, returning the blob's
 * URL from the first server that accepted it. Throws if every server rejects.
 */
export async function uploadBlob(bytes: Uint8Array, servers: string[], signer: ISigner): Promise<string> {
  // Adapt our Concord Signer to the SDK's `(draft) => SignedEvent` shape, and
  // sign a fresh upload auth per (server, blob-hash) request.
  const sign: BlossomSigner = (draft) => signer.signEvent(draft);
  const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });

  const results = await Actions.multiServerUpload(servers, blob, {
    onAuth: (_server, sha256, authType) =>
      createUploadAuth(sign, sha256, { message: "Upload community image", type: authType }),
  });

  const descriptor = [...results.values()][0];
  if (!descriptor?.url) throw new Error("upload failed on all servers");
  return descriptor.url;
}
