// @vitest-environment jsdom
import { act, createElement, memo, Profiler, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { BehaviorSubject } from "rxjs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ConcordCommunity } from "@applesauce/concord";
import type { ChatMessage } from "../src/chat/fold";
import type { ChannelMessage as MessageComponent } from "../src/views/channel/ChannelMessage";
import { ChannelView } from "../src/views/channel/ChannelView";

const state = vi.hoisted(() => ({
  community: undefined as ConcordCommunity | undefined,
  messages: undefined as unknown as BehaviorSubject<ChatMessage[]>,
  favorites: [],
  account: { pubkey: "me" },
  rowRenders: vi.fn(),
  rowMounts: vi.fn(),
  rowUnmounts: vi.fn(),
  markRead: vi.fn(),
}));
vi.mock("applesauce-react/hooks", async () => {
  const { useMemo, useSyncExternalStore } = await import("react");
  return {
    useActiveAccount: () => state.account,
    use$: function useObservable(source: BehaviorSubject<unknown> | (() => BehaviorSubject<unknown> | undefined) | undefined, deps: unknown[] = []) {
      // Match the SDK hook's stable factory/dependency subscription boundary.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const stream = useMemo(() => typeof source === "function" ? source() : source, [typeof source === "function" ? undefined : source, ...deps]);
      return useSyncExternalStore(
        (notify) => { const sub = stream?.subscribe(notify); return () => sub?.unsubscribe(); },
        () => stream?.value,
      );
    },
  };
});
vi.mock("../src/hooks/use-community", () => ({ useCommunity: () => state.community }));
vi.mock("../src/chat/useMessages", async () => {
  const { use$ } = await import("applesauce-react/hooks");
  return { useMessages: () => use$(state.messages) };
});
vi.mock("../src/chat/useUnread", () => ({ useMarkRead: state.markRead, useNewMessagesDivider: () => undefined }));
vi.mock("../src/hooks/use-dev-mode", () => ({ useDevMode: () => false }));
vi.mock("../src/hooks/use-favorite-emojis", () => ({ useFavoriteEmojis: () => state.favorites }));
vi.mock("../src/hooks/use-user-search", () => ({ useCommunityUserSearch: () => ({ search: () => [] }) }));
vi.mock("../src/components/User", () => ({ UserName: () => null }));
vi.mock("../src/components/EmojiPicker", () => ({ EmojiPicker: () => null }));
vi.mock("../src/components/ForumPosts", () => ({ ForumPosts: () => null }));
vi.mock("../src/components/ChannelPins", () => ({ ChannelPins: () => null }));
vi.mock("../src/components/DirectInviteModal", () => ({ DirectInviteModal: () => null }));
vi.mock("../src/components/voice/ChannelCall", () => ({ ChannelCallButton: () => null, VoiceCallPanel: () => null }));
vi.mock("../src/views/channel/PrivateChannelDebugModal", () => ({ PrivateChannelDebugModal: () => null }));
vi.mock("../src/views/channel/ThreadView", () => ({ ThreadView: () => null }));
vi.mock("../src/views/channel/ChannelMessage", () => ({
  ChannelMessage: memo(({ m, onReply }: Parameters<typeof MessageComponent>[0]) => {
    state.rowRenders(m.id);
    useEffect(() => {
      state.rowMounts(m.id);
      return () => { state.rowUnmounts(m.id); };
    }, [m.id]);
    return createElement("div", { "data-msg-id": m.id, tabIndex: -1 },
      m.content, createElement("button", { onClick: () => onReply({ id: m.id, author: m.author }) }, "Reply"));
  }),
}));

const message = (i: number): ChatMessage => ({
  id: `m${i}`, author: "alice", ms: i * 1000, content: `Message ${i}`, deleted: false,
  reactions: [], attachments: [], emojiTags: [], threadReplyCount: 0,
  raw: { id: `m${i}`, pubkey: "alice", kind: 9, content: `Message ${i}`, tags: [], created_at: i },
});

let root: Root;
let host: HTMLDivElement;
let errors: ReturnType<typeof vi.spyOn>;
let draft: { load: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
let restoreScrollTo: () => void;
const observers = new Set<ResizeObserverMock>();
class ResizeObserverMock {
  targets = new Set<Element>();
  callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.add(this); }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); observers.delete(this); }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  errors = vi.spyOn(console, "error").mockImplementation((...args) => {
    if (String(args[0]).includes("same key")) throw new Error(`Duplicate sibling key: ${String(args[1])}`);
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(48);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 48, width: 800, height: 48, toJSON() {},
  }));
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return Number.parseFloat(this.firstElementChild instanceof HTMLElement ? this.firstElementChild.style.height : "") || 600;
  });
  const scrollTo = HTMLElement.prototype.scrollTo;
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value(this: HTMLElement, options: ScrollToOptions) {
    this.scrollTop = options.top ?? 0;
    // Browsers deliver scroll asynchronously, not during React's layout commit.
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  } });
  // Restore the jsdom prototype too; unrelated tests must not inherit the shim.
  restoreScrollTo = () => Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  draft = { load: vi.fn().mockResolvedValue({ text: "", files: [] }), set: vi.fn().mockResolvedValue(undefined), send: vi.fn() };
  const channel = { draft: () => draft };
  state.community = {
    metadata$: new BehaviorSubject({ description: "Community" }),
    channelViews$: new BehaviorSubject([{ channel_id: "channel", name: "chat", accessible: true }]),
    dissolved$: new BehaviorSubject(false),
    material: { owner: "owner" },
    getChannel: () => channel,
    can$: () => new BehaviorSubject(false),
  } as unknown as ConcordCommunity;
  state.messages = new BehaviorSubject(Array.from({ length: 100 }, (_, i) => message(i)));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  restoreScrollTo();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  observers.clear();
});

const props = {
  cid: "community", channelId: "channel", mobileNav: null, threadsOpen: false, membersOpen: false,
  onToggleThreads: () => {}, onToggleMembers: () => {}, onOpenThread: () => {},
};
async function render(commits: () => void, membersOpen = false) {
  await act(async () => {
    root.render(createElement(MemoryRouter, null,
      createElement(Profiler, { id: "channel", onRender: commits }, createElement(ChannelView, { ...props, membersOpen }))));
  });
}
async function settle() {
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
}
async function notifyObservers() {
  await act(async () => {
    for (const observer of [...observers]) observer.callback([...observer.targets].map((target) => ({
      target, borderBoxSize: [{ inlineSize: 800, blockSize: 48 }],
    })) as ResizeObserverEntry[], observer as unknown as ResizeObserver);
  });
}

it("mounts the actual timeline and composer together without duplicate keys", async () => {
  await render(vi.fn());
  await settle();
  expect(host.querySelectorAll('[class*="overflow-anchor"]')).toHaveLength(1);
  expect(host.querySelectorAll("textarea")).toHaveLength(1);
  expect(draft.load).toHaveBeenCalledTimes(1);
  expect(errors).not.toHaveBeenCalled();
});

it("settles while idle and preserves the same scroll element across parent/observer updates", async () => {
  const commits = vi.fn();
  const listeners = vi.spyOn(HTMLElement.prototype, "addEventListener");
  await render(commits);
  await settle();
  const scroll = host.querySelector('[class*="overflow-anchor"]')!;
  const textarea = host.querySelector("textarea")!;
  const mountedRows = state.rowMounts.mock.calls.length;
  const renderedRows = state.rowRenders.mock.calls.length;
  const scrollListeners = () => listeners.mock.calls.filter(([type]) => type === "scroll").length;
  const subscriptions = scrollListeners();
  for (let i = 0; i < 10; i++) {
    await render(commits, Boolean(i % 2));
    await notifyObservers();
    await settle();
    expect(host.querySelector('[class*="overflow-anchor"]')).toBe(scroll);
    expect(host.querySelector("textarea")).toBe(textarea);
  }
  expect(scrollListeners()).toBe(subscriptions);
  expect(draft.load).toHaveBeenCalledTimes(1);
  expect(state.rowMounts).toHaveBeenCalledTimes(mountedRows);
  expect(state.rowRenders).toHaveBeenCalledTimes(renderedRows);
  const idleCommits = commits.mock.calls.length;
  for (let i = 0; i < 10; i++) { await notifyObservers(); await settle(); }
  expect(commits).toHaveBeenCalledTimes(idleCommits);
  await act(async () => state.messages.next([...state.messages.value, message(100)]));
  await settle();
  const appendCommits = commits.mock.calls.length;
  for (let i = 0; i < 5; i++) { await notifyObservers(); await settle(); }
  expect(commits).toHaveBeenCalledTimes(appendCommits);
  expect(host.querySelectorAll('[class*="overflow-anchor"]')).toHaveLength(1);
  expect(host.querySelector('[class*="overflow-anchor"]')).toBe(scroll);
  expect(scrollListeners()).toBe(subscriptions);
  expect(draft.load).toHaveBeenCalledTimes(1);
  expect(errors).not.toHaveBeenCalled();
});
