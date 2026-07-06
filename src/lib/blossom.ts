// Blossom blob upload, on top of `blossom-client-sdk`.
//
// Concord uploads only *ciphertext* blobs (see image.ts), so a media server
// never sees plaintext. The SDK handles the BUD-02/BUD-04 dance (upload to the
// first server, mirror to the rest, preflight HEAD checks); we supply the
// server list and a kind-24242 auth event signed by the user's own key.

import { Actions, createUploadAuth, type Signer as BlossomSigner } from "blossom-client-sdk";
import type { Signer } from "../concord/stream";

/**
 * Default Blossom media servers used when the user has no kind-10063 server
 * list. Order follows BUD-03's "most trusted first" convention.
 */
export const DEFAULT_BLOSSOM_SERVERS = ["https://blossom.primal.net/", "https://blossom.band/"];

/** Parse a kind-10063 Blossom server list event's tags into validated URLs. */
export function parseBlossomServerList(tags: string[][]): string[] {
  return tags
    .filter(([name]) => name === "server")
    .map(([, url]) => url)
    .filter((url) => {
      try {
        new URL(url);
        return true;
      } catch {
        return false;
      }
    });
}

function normalizeUrl(url: string): string {
  return url.toLowerCase().replace(/\/+$/, "");
}

/** Merge the user's servers with the app defaults, deduplicated, user first. */
export function mergeBlossomServers(userServers: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const url of [...userServers, ...DEFAULT_BLOSSOM_SERVERS]) {
    const key = normalizeUrl(url);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(url);
    }
  }
  return merged;
}

/**
 * Upload ciphertext bytes to the given Blossom servers, returning the blob's
 * URL from the first server that accepted it. Throws if every server rejects.
 */
export async function uploadBlob(bytes: Uint8Array, servers: string[], signer: Signer): Promise<string> {
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
