// Encrypted community images (icon / banner) — CORD-02 §6.
//
// Images never touch a media server in plaintext: each is AES-256-GCM
// encrypted under a fresh random key and uploaded as an ordinary blob (see
// blossom.ts); the Control Plane metadata carries only the pointer
// `{url, key, nonce, hash}`. A member fetches the ciphertext, decrypts, and
// verifies the plaintext SHA-256 against `hash`, so the media server learns
// nothing and a swapped blob fails closed.
//
// The pointer carries no mime/extension, so decrypted bytes are sniffed by
// magic numbers for display.

import { sha256 } from "@noble/hashes/sha2.js";
import { toHex, fromHex, randomBytes } from "./bytes";
import type { BlobPointer } from "applesauce-concord";

/** 16-byte (128-bit) AES-GCM nonce. */
const NONCE_BYTES = 16;

const CACHE_NAME = "concord-images";

/** Copy into a fresh ArrayBuffer-backed view (WebCrypto wants BufferSource). */
function buf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const ab = new ArrayBuffer(bytes.byteLength);
  const view = new Uint8Array(ab);
  view.set(bytes);
  return view;
}

/** Best-effort mime from magic bytes (display only). */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 1 && bytes[0] === 0x3c) return "image/svg+xml"; // '<' — svg-ish
  return "application/octet-stream";
}

/** AES-GCM encrypt file bytes; returns ciphertext plus the pointer fields to seal in metadata. */
export async function encryptImageBlob(
  file: File | Blob,
): Promise<{ ciphertext: Uint8Array; key: string; nonce: string; hash: string }> {
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

async function readCached(hash: string): Promise<Blob | undefined> {
  try {
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(`/${hash}`);
    return res ? await res.blob() : undefined;
  } catch {
    return undefined;
  }
}

async function writeCached(hash: string, plaintext: Uint8Array, mime: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(`/${hash}`, new Response(buf(plaintext), { headers: { "Content-Type": mime } }));
  } catch {
    // best-effort
  }
}

/**
 * Fetch + decrypt a {@link BlobPointer} to an object URL. Verifies the
 * plaintext SHA-256 against `pointer.hash`; the caller revokes the URL. A
 * content-addressed disk cache (Cache Storage) skips re-fetch + re-decrypt
 * across reloads.
 */
export async function decryptImagePointer(pointer: BlobPointer, signal?: AbortSignal): Promise<string> {
  return decryptToObjectURL(pointer.url, pointer.key, pointer.nonce, { hash: pointer.hash, signal });
}

/**
 * Fetch + AES-GCM-decrypt an encrypted blob (community icon/banner or a chat
 * attachment) into an object URL. When `hash` is given, the plaintext SHA-256 is
 * verified and a swapped blob fails closed; `mime` overrides the sniffed type
 * (needed for video/audio, which magic-byte sniffing doesn't cover). Results are
 * disk-cached by content hash so reloads skip re-fetch + re-decrypt.
 */
export async function decryptToObjectURL(
  url: string,
  keyHex: string,
  nonceHex: string,
  opts: { hash?: string; mime?: string; signal?: AbortSignal } = {},
): Promise<string> {
  // Persistent (Cache Storage) caching is content-addressed, so only when a hash
  // is known; otherwise the in-memory hook cache handles dedup for the session.
  if (opts.hash) {
    const cached = await readCached(opts.hash);
    if (cached) return URL.createObjectURL(cached);
  }

  const res = await fetch(url, { signal: opts.signal });
  if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`);
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  const cryptoKey = await crypto.subtle.importKey("raw", buf(fromHex(keyHex)), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(fromHex(nonceHex)) }, cryptoKey, buf(ciphertext));
  const plaintext = new Uint8Array(pt);

  if (opts.hash && toHex(sha256(plaintext)) !== opts.hash.toLowerCase()) {
    throw new Error("attachment integrity check failed");
  }
  const mime = opts.mime ?? sniffImageMime(plaintext);
  if (opts.hash) void writeCached(opts.hash, plaintext, mime);
  return URL.createObjectURL(new Blob([buf(plaintext)], { type: mime }));
}
