import { nip19 } from "nostr-tools";
import { PrivateKeySigner } from "applesauce-signers";

export type CredentialKind = "bunker" | "session" | "private-key" | "encrypted-key" | "public-key" | "invitation" | "unknown";

export function hasBrowserSigner(target: object): boolean {
  if (!("nostr" in target) || !target.nostr || typeof target.nostr !== "object") return false;
  return "getPublicKey" in target.nostr && typeof target.nostr.getPublicKey === "function" &&
    "signEvent" in target.nostr && typeof target.nostr.signEvent === "function";
}

/** Recognition is local only. Pasting never starts a connection or decrypts a key. */
export function credentialKind(input: string): CredentialKind {
  const value = input.trim();
  if (value.startsWith("bunker://")) return "bunker";
  if (value.startsWith("nbunksec1")) return "session";
  if (value.startsWith("ncryptsec1")) return "encrypted-key";
  if (value.startsWith("npub1") || value.startsWith("nprofile1")) return "public-key";
  if (value.startsWith("nostrconnect://")) return "invitation";
  if (value.startsWith("nsec1") || /^[0-9a-f]{64}$/i.test(value)) return "private-key";
  return "unknown";
}

export function privateKeyBytes(input: string): Uint8Array {
  const value = input.trim();
  if (value.startsWith("nsec1")) {
    const decoded = nip19.decode(value);
    if (decoded.type !== "nsec") throw new Error("Invalid private key");
    return PrivateKeySigner.fromKey(decoded.data).key;
  }
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("Invalid private key");
  return PrivateKeySigner.fromKey(value).key;
}

export function signerRelays(input: string): string[] {
  const values = input.trim().split(/[\s,]+/).filter(Boolean);
  if (!values.length) throw new Error("Enter at least one signer relay.");
  return [...new Set(values.map((value) => {
    let url: URL;
    try { url = new URL(value.includes("://") ? value : `wss://${value}`); }
    catch { throw new Error("Enter valid ws:// or wss:// relay addresses."); }
    if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
      throw new Error("Enter valid ws:// or wss:// relay addresses without credentials or fragments.");
    }
    return url.toString();
  }))];
}

/** Never use signer-supplied javascript:, data:, or custom schemes as approval links. */
export function approvalUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Invalid signer approval link");
  return url.href;
}
