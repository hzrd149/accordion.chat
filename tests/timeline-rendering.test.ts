// @vitest-environment jsdom
import { act, createElement, createRef, memo } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { ChatMessage } from "../src/chat/fold";
import type { ChannelMessage as MessageComponent } from "../src/views/channel/ChannelMessage";
import { ChannelTimeline } from "../src/views/channel/ChannelTimeline";
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

it("skips parent-only renders and untouched rows; regrouping never remounts a message", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  renders.clear();
  const host = document.createElement("div");
  const root = createRoot(host);
  const props = {
    ref: createRef<HTMLDivElement>(), channelName: "chat", ownerPubkey: "owner", myPubkey: "me",
    canWrite: true, community: undefined, channelId: "channel", dividerId: undefined,
    favorites: [], quickReactions: [], onReply: vi.fn(), onJumpToMessage: vi.fn(), onThread: vi.fn(),
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
  }
});
