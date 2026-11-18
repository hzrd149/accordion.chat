import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Media, type ConcordClient } from "@applesauce/concord";
import { BehaviorSubject } from "rxjs";
import { attachMediaGc, createMediaTransport, createMediaURLScope, retireLegacyImageCache, revokeAccountMedia } from "../src/services/concord-media";
import { encryptImageBlob } from "../src/helpers/image";
import { AES_GCM_TAG_BYTES, assertMediaUploadSize, MAX_ATTACHMENT_DOWNLOAD_BYTES, MAX_MEDIA_CIPHERTEXT_BYTES, MAX_MEDIA_UPLOAD_BYTES } from "../src/helpers/media-policy";
import { authorizedMediaSlides } from "../src/helpers/media-slides";
import { fromHex } from "../src/helpers/bytes";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

afterEach(() => {
  revokeAccountMedia("alice");
  revokeAccountMedia("bob");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("app-owned Concord media rendering lifecycle", () => {
  it("drops decoded lightbox slides on access/visibility loss and replacement", () => {
    const slides = [{ src: "blob:old-private" }, { src: "blob:still-authorized" }];
    expect(authorizedMediaSlides(slides, ["blob:still-authorized"])).toEqual([slides[1]]);
    expect(authorizedMediaSlides(slides, [])).toEqual([]);
    expect(authorizedMediaSlides(slides, ["blob:new-private-scope"])).toEqual([]);
  });

  function mockURLs() {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:verified");
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    return { create, revoke };
  }

  it("revokes on unmount, aborts reads and refuses late plaintext results", () => {
    const { create, revoke } = mockURLs();
    const retired = vi.fn();
    const scope = createMediaURLScope("alice", "community", retired);
    expect(scope.create(new Blob(["verified"]))).toBe("blob:verified");
    scope.dispose();
    scope.dispose();
    expect(scope.signal.aborted).toBe(true);
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:verified");
    expect(scope.create(new Blob(["late"]))).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(retired).toHaveBeenCalledTimes(1);
  });

  it("account logout cannot reuse URLs or cancel another account's media", () => {
    const { revoke } = mockURLs();
    const alice = createMediaURLScope("alice", "community");
    const bob = createMediaURLScope("bob", "community");
    alice.create(new Blob(["alice"]));
    bob.create(new Blob(["bob"]));
    revokeAccountMedia("alice");
    expect(alice.signal.aborted).toBe(true);
    expect(bob.signal.aborted).toBe(false);
    expect(revoke).toHaveBeenCalledTimes(1);
    expect(alice.create(new Blob(["late"]))).toBeNull();
  });

  it("leaving a community revokes its mounted media; provider teardown retires the rest", () => {
    mockURLs();
    const community = { material: { community_id: "joined" } };
    const communities$ = new BehaviorSubject([community]);
    const detach = attachMediaGc({ communities$ } as unknown as ConcordClient, "alice");
    const scope = createMediaURLScope("alice", "joined");
    scope.create(new Blob(["secret"]));
    communities$.next([]);
    expect(scope.signal.aborted).toBe(true);
    const another = createMediaURLScope("alice", "other");
    detach();
    expect(another.signal.aborted).toBe(true);
  });

  it("deletes only the named legacy plaintext cache and never imports entries", async () => {
    const remove = vi.fn().mockResolvedValue(true);
    await retireLegacyImageCache({ delete: remove });
    expect(remove).toHaveBeenCalledExactlyOnceWith("concord-images");
  });
});

describe("explicit media transport policy", () => {
  it("rejects untrusted origins, plaintext URLs and private destinations before fetching", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const transport = createMediaTransport();
    const options = { signal: new AbortController().signal, maxBytes: 1024 };
    for (const url of ["https://untrusted.example/file", "http://blossom.band/file", "https://127.0.0.1/file",
      "https://user:pass@blossom.band/file", "https://localhost/file"]) {
      await expect(transport(url, options)).rejects.toThrow();
    }
    expect(fetcher).not.toHaveBeenCalled();
    expect(() => createMediaTransport("https://localhost")).toThrow();
    expect(() => createMediaTransport("https://custom.example/path")).toThrow();
  });

  it("permits explicitly configured custom Blossom origins with SDK bounded, private fetch options", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
    vi.stubGlobal("fetch", fetcher);
    const signal = new AbortController().signal;
    expect(await createMediaTransport(" https://custom.example ")("https://custom.example/cipher", { signal, maxBytes: 3 }))
      .toEqual(new Uint8Array([1, 2, 3]));
    expect(fetcher).toHaveBeenCalledWith("https://custom.example/cipher", {
      signal, credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
    });
    await expect(createMediaTransport("https://custom.example")("https://custom.example/cipher", { signal, maxBytes: 2 }))
      .rejects.toThrow();
  });
});

describe("upload encryption and SDK ciphertext storage", () => {
  it("rejects oversized uploads before reading or encrypting, reserving the AES-GCM tag", async () => {
    expect(MAX_MEDIA_UPLOAD_BYTES + AES_GCM_TAG_BYTES).toBe(MAX_MEDIA_CIPHERTEXT_BYTES);
    expect(MAX_MEDIA_CIPHERTEXT_BYTES).toBe(32 * 1024 * 1024);
    expect(() => assertMediaUploadSize({ size: MAX_MEDIA_UPLOAD_BYTES })).not.toThrow();
    const arrayBuffer = vi.fn();
    const oversized = { size: MAX_MEDIA_UPLOAD_BYTES + 1, arrayBuffer } as unknown as Blob;
    await expect(encryptImageBlob(oversized)).rejects.toThrow("16-byte encryption tag");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(MAX_ATTACHMENT_DOWNLOAD_BYTES).toBe(128 * 1024 * 1024);
  });

  it("preserves AES-GCM upload ciphertext and plaintext hash compatibility", async () => {
    const file = new Blob(["upload plaintext"]);
    const encrypted = await encryptImageBlob(file);
    expect(encrypted.nonce).toHaveLength(32);
    const key = await crypto.subtle.importKey("raw", fromHex(encrypted.key), "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromHex(encrypted.nonce) }, key, encrypted.ciphertext);
    expect(new TextDecoder().decode(plaintext)).toBe("upload plaintext");
    expect(encrypted.hash).toBe(bytesToHex(sha256(new Uint8Array(plaintext))));
  });

  it("uses the SDK's account-scoped encrypted stores with awaited close and erasure", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const alice = Media.createIndexedDBMediaStoreFactory("aa".repeat(32));
    const bob = Media.createIndexedDBMediaStoreFactory("bb".repeat(32));
    try {
      await alice("community", { kind: "private-channel", channelId: "private" }).put("descriptor", new Uint8Array([1]));
      await bob("community", { kind: "private-channel", channelId: "private" }).put("descriptor", new Uint8Array([2]));
      await alice.close();
      await alice.deleteAll();
      expect(await bob("community", { kind: "private-channel", channelId: "private" }).get("descriptor")).toEqual(new Uint8Array([2]));
      const names = (await indexedDB.databases()).map(({ name }) => name);
      expect(names.some((name) => name?.includes("aa".repeat(32)))).toBe(false);
    } finally {
      await alice.close();
      await bob.deleteAll();
    }
  });
});
