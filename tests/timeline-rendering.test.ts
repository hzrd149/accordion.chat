// @vitest-environment jsdom
import { act, createElement, createRef, memo } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/chat/fold";
import type { ChannelMessage as MessageComponent } from "../src/views/channel/ChannelMessage";
import { ChannelTimeline, type ChannelTimelineHandle } from "../src/views/channel/ChannelTimeline";
import { foldChannel } from "../src/chat/fold";
import type { ConcordChannelMessage } from "@applesauce/concord";

const renders = vi.hoisted(() => new Map<string, number>());
vi.mock("../src/hooks/use-dev-mode", () => ({ useDevMode: () => false }));
vi.mock("../src/views/channel/ChannelMessage", () => ({
  ChannelMessage: memo(({ m }: Parameters<typeof MessageComponent>[0]) => {
    renders.set(m.id, (renders.get(m.id) ?? 0) + 1);
    return createElement("div", { "data-msg-id": m.id }, m.content);
  }),
}));

const row = (id: string, author: string, time: number): ConcordChannelMessage => ({
  rumor: { id, kind: 9, pubkey: author, content: id, tags: [], created_at: time }, content: id,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number.parseFloat(this.firstElementChild instanceof HTMLElement ? this.firstElementChild.style.height : "") || 600;
  });
  HTMLElement.prototype.scrollTo = function (options) {
    if (typeof options === "object") this.scrollTop = options.top ?? 0;
    this.dispatchEvent(new Event("scroll"));
  };
});

it("skips parent-only renders and untouched rows; regrouping never remounts a message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders.clear();
  const host = document.createElement("div");
  const root = createRoot(host);
  const props = {
    ref: createRef<ChannelTimelineHandle>(), channelName: "chat", ownerPubkey: "owner", myPubkey: "me",
    canWrite: true, community: undefined, channelId: "channel", dividerId: undefined,
    favorites: [], quickReactions: [], onReply: vi.fn(), onJumpToMessage: vi.fn(), onThread: vi.fn(), onAtBottomChange: vi.fn(),
  };
  const render = async (messages: ChatMessage[]) => {
    await act(async () => root.render(createElement(ChannelTimeline, { ...props, messages })));
  };
  const first = row("first", "alice", 1000);
  const second = row("second", "bob", 1001);
  let view = foldChannel([first, second], []);
  try {
    await render(view.messages);
    const node = host.querySelector('[data-msg-id="second"]');
    await render(view.messages);
    expect([...renders.values()]).toEqual([1, 1]);

    const third = row("third", "bob", 1002);
    view = foldChannel([first, second, third], [], view);
    await render(view.messages);
    expect(renders.get("first")).toBe(1);
    expect(renders.get("second")).toBe(1);
    expect(renders.get("third")).toBe(1);

    // Historical input changes a group's first ID. It must not move existing
    // rows between keyed parent containers (which remounts their media).
    const history = row("history", "bob", 1000.5);
    view = foldChannel([first, history, second, third], [], view);
    await render(view.messages);
    expect(host.querySelector('[data-msg-id="second"]')).toBe(node);
    expect(renders.get("third")).toBe(1);

    view = foldChannel([first, history, second, third], [{
      id: "reaction", kind: 7, pubkey: "me", content: "👍", created_at: 1003, tags: [["e", "first"]],
    }], view);
    await render(view.messages);
    expect(renders.get("first")).toBe(2);
    expect(renders.get("third")).toBe(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("mounts a bounded window of a long history and jumps to an unmounted message", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ref = createRef<ChannelTimelineHandle>();
  const onAtBottomChange = vi.fn();
  const messages = foldChannel(Array.from({ length: 10_000 }, (_, i) => row(`m${i}`, "alice", i)), []).messages;
  try {
    await act(async () => root.render(createElement(ChannelTimeline, {
      ref, messages, channelName: "chat", ownerPubkey: "owner", myPubkey: "me",
      canWrite: true, community: undefined, channelId: "channel", dividerId: undefined,
      favorites: [], quickReactions: [], onReply: vi.fn(), onJumpToMessage: vi.fn(), onThread: vi.fn(), onAtBottomChange,
    })));
    expect(host.querySelectorAll("[data-msg-id]").length).toBeLessThan(60);
    expect(host.querySelector('[data-msg-id="m9999"]')).not.toBeNull();
    expect(host.querySelector('[data-msg-id="m5000"]')).toBeNull();
    const bottomNotifications = onAtBottomChange.mock.calls.length;
    const scroll = host.querySelector('[class*="overflow-anchor"]')!;
    await act(async () => {
      for (let i = 0; i < 20; i++) scroll.dispatchEvent(new Event("scroll"));
    });
    expect(onAtBottomChange).toHaveBeenCalledTimes(bottomNotifications);
    await act(async () => { expect(ref.current!.scrollToMessage("m5000")).toBe(true); });
    expect(host.querySelector('[data-msg-id="m5000"]')).not.toBeNull();
    expect(onAtBottomChange).toHaveBeenLastCalledWith(false);
    expect(ref.current!.scrollToMessage("missing")).toBe(false);
    expect(host.querySelectorAll("[data-msg-id]").length).toBeLessThan(60);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
