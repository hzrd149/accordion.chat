// Encrypted community images (icon / banner) — CORD-02 §6.
//
// Images never touch a media server in plaintext: each is AES-256-GCM
// encrypted under a fresh random key and uploaded as an ordinary blob (see
// blossom.ts); the Control Plane metadata carries only the pointer
// `{url, key, nonce, hash}`. A member fetches the ciphertext, decrypts, and
// verifies the plaintext SHA-256 against `hash`, so the media server learns
// nothing and a swapped blob fails closed.
//
// Downloading, decryption, integrity checks and ciphertext persistence belong to
// Concord's media services; this module only owns upload encryption.

import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, randomBytes } from "./bytes";
import { assertMediaUploadSize } from "./media-policy";

/** 16-byte (128-bit) AES-GCM nonce. */
const NONCE_BYTES = 16;

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto wants BufferSource). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);
  return view;
}

/** AES-GCM encrypt file bytes; returns ciphertext plus the pointer fields to seal in metadata. */
export async function encryptImageBlob(
  file: File | Blob,
): Promise<{ ciphertext: Uint8Array; key: string; nonce: string; hash: string }> {
  assertMediaUploadSize(file);
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const keyBytes = randomBytes(32);
  const nonceBytes = randomBytes(NONCE_BYTES);
  const cryptoKey = await crypto.subtle.importKey("raw", buf(keyBytes), "AES-GCM", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonceBytes) }, cryptoKey, buf(plaintext));
  return {
    ciphertext: new Uint8Array(ct),
    key: toHex(keyBytes),
    nonce: toHex(nonceBytes),
    hash: toHex(sha256(plaintext)),
  };
}
