import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConcordChannelDraft, Drafts } from "@applesauce/concord";

const state = vi.hoisted(() => ({
  value: { text: "Hello :wave:", files: [] } as Drafts.ConcordMessageDraft,
  update: vi.fn(),
  send: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("react", () => ({
  useEffect: vi.fn(),
  useRef: () => ({ current: null }),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("../src/hooks/use-channel-draft", () => ({
  useChannelDraft: () => ({ ...state, ready: true, error: "" }),
}));
vi.mock("../src/components/User", () => ({ UserName: () => null }));
vi.mock("../src/components/EmojiPicker", () => ({ EmojiPicker: () => null }));

import { ThreadComposer } from "../src/views/channel/ThreadComposer";

function findSend(node: ReactNode): (() => Promise<void>) | undefined {
  if (!node || typeof node !== "object" || !("props" in node)) return;
  const element = node as ReactElement<{ title?: string; onClick?: () => Promise<void>; children?: ReactNode }>;
  if (element.type === "button" && element.props.title === "Send") return element.props.onClick;
  const children = element.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findSend(child);
    if (found) return found;
  }
}

describe("thread composer SDK routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.update.mockReset();
    state.value = { text: "Hello :wave:", files: [] };
  });

  it("sends emoji-only replies with the SDK draft, not the attachment fallback", async () => {
    const favorites = [{ shortcode: "wave", url: "https://example.com/wave.png" }];
    const onSend = vi.fn();
    const tree = ThreadComposer({
      draft: {} as ConcordChannelDraft, replyingTo: null, fullPage: false,
      favorites, onClear: vi.fn(), onSend,
    });
    const send = findSend(tree);
    expect(send).toBeTypeOf("function");
    await send!();
    expect(state.update).toHaveBeenCalledWith({ emojis: favorites });
    expect(state.send).toHaveBeenCalledWith(undefined, undefined);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("uses the send snapshot's files and text for attachment replies", async () => {
    const file = new File(["image"], "image.png");
    state.value = { text: "Original", files: [file] };
    const onSend = vi.fn().mockResolvedValue(undefined);
    const tree = ThreadComposer({
      draft: {} as ConcordChannelDraft, replyingTo: null, fullPage: false,
      favorites: [], onClear: vi.fn(), onSend,
    });
    await findSend(tree)!();
    const publish = state.send.mock.calls[0][1] as (snapshot: Drafts.ConcordMessageDraft) => Promise<void>;
    const snapshotFile = new File(["different"], "snapshot.png");
    await publish({ text: "Snapshot", files: [snapshotFile] });
    expect(onSend).toHaveBeenCalledWith("Snapshot", [snapshotFile], expect.any(Function), []);
  });

  it.each([false, true])("retains a restored draft's removed favorite on retry (attachments: %s)", async (attachments) => {
    const retained = { shortcode: "wave", url: "https://example.com/removed-wave.png" };
    const previous = { shortcode: "party", url: "https://example.com/old-party.png" };
    const current = { shortcode: "party", url: "https://example.com/current-party.png" };
    const files = attachments ? [new File(["image"], "image.png")] : [];
    state.value = { text: "Retry :wave: :party:", files, emojis: [retained, previous] };
    state.update.mockImplementation((change: Partial<Drafts.ConcordMessageDraft>) => {
      state.value = { ...state.value, ...change };
    });
    const onSend = vi.fn().mockResolvedValue(undefined);
    const tree = ThreadComposer({
      draft: {} as ConcordChannelDraft, replyingTo: null, fullPage: false,
      favorites: [current], onClear: vi.fn(), onSend,
    });
    await findSend(tree)!();
    expect(state.value.emojis).toEqual([current, retained]);
    if (attachments) {
      const publish = state.send.mock.calls[0][1] as (snapshot: Drafts.ConcordMessageDraft) => Promise<void>;
      await publish(state.value);
      expect(onSend).toHaveBeenCalledWith(state.value.text, files, expect.any(Function), [current, retained]);
    } else {
      expect(state.send).toHaveBeenCalledWith(undefined, undefined);
      expect(onSend).not.toHaveBeenCalled();
    }
  });
});
