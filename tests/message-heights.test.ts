// @vitest-environment jsdom
import { act, createElement, Profiler } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { createMessageHeightCache, type MessageLayout } from "../src/helpers/message-heights";
import { MeasuredMessage } from "../src/components/MeasuredMessage";
import { foldChannel } from "../src/chat/fold";

function layout(): MessageLayout {
  return {
    message: foldChannel([{
      rumor: { id: "message", kind: 9, pubkey: "alice", content: "hello", tags: [], created_at: 1 },
      content: "hello",
    }], []).messages[0],
    showHeader: true, groupStart: false, divider: false,
  };
}

it("invalidates heights for changed content, grouping, dividers and width", () => {
  const cache = createMessageHeightCache();
  const row = layout();
  cache.set(row, 800, 350);
  expect(cache.get({ ...row }, 800)).toBe(350);
  expect(cache.get(row, 400)).toBeUndefined();
  expect(cache.get({ ...row, message: { ...row.message, edited: "short" } }, 800)).toBeUndefined();
  expect(cache.get({ ...row, showHeader: false }, 800)).toBeUndefined();
  expect(cache.get({ ...row, groupStart: true }, 800)).toBeUndefined();
  expect(cache.get({ ...row, divider: true }, 800)).toBeUndefined();
  cache.set(row, 800, 0);
  expect(cache.get(row, 800)).toBe(350);
  expect(createMessageHeightCache().get(row, 800)).toBeUndefined();
  cache.retain(new Set());
  expect(cache.get(row, 800)).toBeUndefined();
});

it("reserves the last loaded height on remount, then releases it on ready/error", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resize = () => {};
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  let naturalHeight = 350;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: naturalHeight,
    width: 800, height: naturalHeight, toJSON() {},
  }));
  const cache = createMessageHeightCache();
  const row = layout();
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async (pending: boolean) => {
    await act(async () => root.render(createElement(MeasuredMessage, {
      cache, layout: row, width: 800,
      children: createElement("div", pending ? { "data-message-pending": true } : {}, "media"),
    })));
  };
  try {
    await render(false);
    expect(cache.get(row, 800)).toBe(350);
    // A parent render must not resurrect a minimum height that was released
    // after loading. The original render/cache + imperative-style split did.
    await render(false);
    expect((host.firstChild as HTMLElement).style.minHeight).toBe("");
    await act(async () => root.render(null));
    naturalHeight = 50;
    await render(true);
    expect((host.firstChild as HTMLElement).style.minHeight).toBe("350px");
    expect(cache.get(row, 800)).toBe(350);
    naturalHeight = 420;
    await act(async () => resize());
    // Growth is natural content, not a measured height fed back into CSS.
    expect((host.firstChild as HTMLElement).style.minHeight).toBe("350px");
    expect(cache.get(row, 800)).toBe(420);
    // A terminal error is allowed to shrink, rather than leaving a permanent gap.
    naturalHeight = 60;
    await render(false);
    expect((host.firstChild as HTMLElement).style.minHeight).toBe("");
    expect(cache.get(row, 800)).toBe(60);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

it("converges under repeated resize notifications and equivalent layout renders", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const callbacks = new Set<() => void>();
  const observers = vi.fn();
  vi.stubGlobal("ResizeObserver", class {
    callback: () => void;
    constructor(callback: () => void) { observers(); this.callback = callback; callbacks.add(callback); }
    observe() {}
    disconnect() { callbacks.delete(this.callback); }
  });
  const heights = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 50,
    width: 800, height: 50, toJSON() {},
  }));
  const cache = createMessageHeightCache();
  const row = layout();
  cache.set(row, 800, 350);
  const commits = vi.fn();
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = async (pending: boolean) => {
    await act(async () => root.render(createElement(Profiler, { id: "row", onRender: commits },
      createElement(MeasuredMessage, {
        cache, layout: { ...row }, width: 800,
        children: createElement("div", pending ? { "data-message-pending": true } : {}, "media"),
      }))));
  };
  try {
    await render(true);
    const initialCommits = commits.mock.calls.length;
    for (let i = 0; i < 20; i++) await act(async () => { for (const callback of callbacks) callback(); });
    expect(commits.mock.calls.length).toBe(initialCommits);
    expect(cache.get(row, 800)).toBe(350);
    expect((host.firstChild as HTMLElement).style.minHeight).toBe("350px");
    // Even changing geometry updates the cache, not the CSS reservation or
    // React state. This is the key break in the measurement feedback path.
    heights.mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 420,
      width: 800, height: 420, toJSON() {},
    }));
    await act(async () => { for (const callback of callbacks) callback(); });
    expect(commits.mock.calls.length).toBe(initialCommits);
    expect(cache.get(row, 800)).toBe(420);
    expect((host.firstChild as HTMLElement).style.minHeight).toBe("350px");
    heights.mockImplementation(() => ({
      x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 50,
      width: 800, height: 50, toJSON() {},
    }));
    // Loading finishes, then unrelated renders and observer deliveries follow.
    await render(false);
    for (let i = 0; i < 5; i++) {
      await render(false);
      await act(async () => { for (const callback of callbacks) callback(); });
      expect((host.firstChild as HTMLElement).style.minHeight).toBe("");
      expect(cache.get(row, 800)).toBe(50);
    }
    expect(observers).toHaveBeenCalledTimes(1);
    expect(heights).toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    expect(callbacks.size).toBe(0);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
