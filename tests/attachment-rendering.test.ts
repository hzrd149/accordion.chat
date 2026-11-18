// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConcordCommunity } from "@applesauce/concord";
import type { MediaAttachment } from "@applesauce/concord/helpers";
import { useAttachmentSources } from "../src/hooks/use-attachment-sources";
import { MessageContent } from "../src/components/MessageContent";
import { revokeAccountMedia } from "../src/services/concord-media";

const auth = vi.hoisted(() => ({ account: { pubkey: "alice" } }));
vi.mock("applesauce-react/hooks", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useActiveAccount: () => auth.account,
    use$: function useObservable(stream?: BehaviorSubject<unknown>) { return useSyncExternalStore(
      (notify) => { const sub = stream?.subscribe(notify); return () => sub?.unsubscribe(); },
      () => stream?.value,
    ); },
  };
});
vi.mock("../src/components/User", () => ({ UserAvatar: () => null, UserName: () => null }));
vi.mock("yet-another-react-lightbox", () => ({ default: () => null }));

const attachment = (url = "https://example.com/image"): MediaAttachment => ({
  url, type: "image/png", dimensions: "640x480",
  encryption: { algorithm: "aes-gcm", key: "a".repeat(64), nonce: "b".repeat(32) },
});

describe("attachment rendering identity and access boundaries", () => {
  let root: Root;
  let host: HTMLDivElement;
  let metadata$: BehaviorSubject<{ accessible: boolean; visibility: string }>;
  let dissolved$: BehaviorSubject<boolean>;
  let load: ReturnType<typeof vi.fn>;
  let community: ConcordCommunity;
  let createURL: ReturnType<typeof vi.fn>;
  let revokeURL: ReturnType<typeof vi.fn>;
  let sources: ReturnType<typeof useAttachmentSources>;

  function Probe({ attachments }: { attachments: MediaAttachment[] }) {
    sources = useAttachmentSources(community, "channel", attachments);
    return null;
  }
  const render = async (attachments: MediaAttachment[]) => {
    await act(async () => { root.render(createElement(Probe, { attachments })); });
  };

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    let nextURL = 0;
    createURL = vi.fn(() => `blob:media-${nextURL++}`);
    revokeURL = vi.fn();
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createURL;
      static revokeObjectURL = revokeURL;
    });
    auth.account = { pubkey: "alice" };
    metadata$ = new BehaviorSubject({ accessible: true, visibility: "public" });
    dissolved$ = new BehaviorSubject(false);
    load = vi.fn(async () => ({ status: "ready", blob: new Blob(["image"]) }));
    const channel = { metadata$, media: { load } };
    community = { material: { community_id: "community" }, getChannel: () => channel, dissolved$ } as unknown as ConcordCommunity;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  it("keeps sources across cloned descriptors and loads only additions/replacements", async () => {
    const original = attachment();
    await render([original]);
    const source = sources.get(original);
    const clone = structuredClone(original);
    await render([clone]);
    expect(sources.get(clone)).toBe(source);
    expect(load).toHaveBeenCalledTimes(1);
    expect(revokeURL).not.toHaveBeenCalled();
    auth.account = { pubkey: "alice" };
    await act(async () => metadata$.next({ accessible: true, visibility: "public" }));
    await render([clone]);
    expect(load).toHaveBeenCalledTimes(1);
    const added = attachment("https://example.com/second");
    await render([clone, added]);
    expect(load).toHaveBeenCalledTimes(2);
    expect(sources.get(clone)).toBe(source);
    const replaced = { ...clone, encryption: { ...clone.encryption!, key: "c".repeat(64) } };
    await render([replaced, added]);
    expect(load).toHaveBeenCalledTimes(3);
    expect(revokeURL).toHaveBeenCalledExactlyOnceWith((source as { src: string }).src);
    await render([]);
    expect(revokeURL).toHaveBeenCalledTimes(3);
  });

  it("does not restart pending loads when descriptors are cloned", async () => {
    let finish!: (value: unknown) => void;
    load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render([attachment()]);
    const signal = load.mock.calls[0][1].signal as AbortSignal;
    const clone = attachment();
    await render([clone]);
    expect(signal.aborted).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => finish({ status: "ready", blob: new Blob(["image"]) }));
    expect(sources.get(clone)).toHaveProperty("src");
  });

  it("retires immediately on access loss and rejects late plaintext", async () => {
    let finish!: (value: unknown) => void;
    load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const original = attachment();
    await render([original]);
    const signal = load.mock.calls[0][1].signal as AbortSignal;
    await act(async () => {
      metadata$.next({ accessible: false, visibility: "public" });
      expect(signal.aborted).toBe(true);
      finish({ status: "ready", blob: new Blob(["late"]) });
    });
    expect(createURL).not.toHaveBeenCalled();
    expect(sources.get(original)).toEqual({ reason: "retired" });
  });

  it("aborts removed/replaced pending descriptors and ignores their late results", async () => {
    const finish: ((value: unknown) => void)[] = [];
    load.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
    const original = attachment();
    await render([original]);
    const firstSignal = load.mock.calls[0][1].signal as AbortSignal;
    const replacement = { ...original, originalSha256: "c".repeat(64) };
    await render([replacement]);
    expect(firstSignal.aborted).toBe(true);
    await act(async () => finish[0]({ status: "ready", blob: new Blob(["late"]) }));
    expect(createURL).not.toHaveBeenCalled();
    await act(async () => finish[1]({ status: "ready", blob: new Blob(["current"]) }));
    expect(sources.get(replacement)).toHaveProperty("src");
    expect(createURL).toHaveBeenCalledTimes(1);
  });

  it("keeps the same video frame dimensions from placeholder to ready", async () => {
    let finish!: (value: unknown) => void;
    load.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const video = { ...attachment(), type: "video/mp4" };
    await act(async () => root.render(createElement(MessageContent, {
      text: "", attachments: [video], community, channelId: "channel",
    })));
    const pending = host.querySelector<HTMLElement>(".animate-pulse")!;
    const frameClass = pending.className.replace(" animate-pulse", "");
    const aspectRatio = pending.style.aspectRatio;
    await act(async () => finish({ status: "ready", blob: new Blob(["video"]) }));
    const ready = host.querySelector("video")!.parentElement!;
    expect(ready.className).toBe(frameClass);
    expect(ready.style.aspectRatio).toBe(aspectRatio);
  });

  it("revokes on visibility/account changes, dissolution and unmount", async () => {
    const original = attachment();
    await render([original]);
    await act(async () => metadata$.next({ accessible: true, visibility: "private" }));
    expect(revokeURL).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(2);
    auth.account = { pubkey: "bob" };
    await render([original]);
    expect(revokeURL).toHaveBeenCalledTimes(2);
    await act(async () => dissolved$.next(true));
    expect(revokeURL).toHaveBeenCalledTimes(3);
    await act(async () => dissolved$.next(false));
    await act(async () => root.render(null));
    expect(revokeURL).toHaveBeenCalledTimes(4);
  });

  it("drops decoded media on logout without waiting for a parent rerender", async () => {
    await act(async () => root.render(createElement(MessageContent, {
      text: "", attachments: [attachment()], community, channelId: "channel",
    })));
    expect(host.querySelector("img")).not.toBeNull();
    await act(async () => revokeAccountMedia("alice"));
    expect(host.querySelector("img")).toBeNull();
  });

  it("preserves the actual image node and URL through unrelated feed updates", async () => {
    const renderContent = async (text: string) => {
      await act(async () => root.render(createElement(MessageContent, {
        text, attachments: [attachment()], community, channelId: "channel",
      })));
    };
    await renderContent("before");
    const image = host.querySelector("img");
    expect(image).not.toBeNull();
    await renderContent("after");
    expect(host.querySelector("img")).toBe(image);
    expect(load).toHaveBeenCalledTimes(1);
    expect(revokeURL).not.toHaveBeenCalled();
    expect(image?.parentElement?.style.aspectRatio).toBe("640 / 480");
  });
});
