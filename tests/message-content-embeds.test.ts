// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { neventEncode } from "nostr-tools/nip19";
import type { NostrEvent } from "nostr-tools";
import { expect, it, vi } from "vitest";
import { MessageContent } from "../src/components/MessageContent";

const state = vi.hoisted(() => ({ event: undefined as NostrEvent | undefined }));
vi.mock("applesauce-react/hooks", async (importOriginal) => ({
  ...await importOriginal<typeof import("applesauce-react/hooks")>(),
  useEventStore: () => ({ event: () => state.event }),
  use$: (source: () => unknown) => source(),
}));
vi.mock("../src/components/User", () => ({ UserName: () => "Alice", UserAvatar: () => null }));
vi.mock("../src/hooks/use-attachment-sources", () => ({ useAttachmentSources: () => new Map() }));

it.each([1, 1111, 6, 16, 30023])("keeps content and event navigation links separate in kind %i embeds", async (kind) => {
  const encoded = neventEncode({ id: "a".repeat(64) });
  const mention = neventEncode({ id: "b".repeat(64) });
  state.event = {
    id: "a".repeat(64), pubkey: "c".repeat(64), sig: "d".repeat(128),
    kind, created_at: 1, tags: [],
    content: `Read https://example.com/page and nostr:${mention}`,
  };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(MessageContent, {
      text: `nostr:${encoded}`, attachments: [],
    })));
    expect(host.querySelector("a a")).toBeNull();
    const contentLink = host.querySelector('a[href="https://example.com/page"]');
    expect(contentLink).not.toBeNull();
    expect(host.querySelector(`a[href="https://njump.me/${mention}"]`)).not.toBeNull();
    const eventLink = host.querySelector(`a[href="https://njump.me/${encoded}"]`);
    expect(eventLink?.textContent).toContain("Open on Nostr");
    expect(eventLink?.getAttribute("target")).toBe("_blank");
    expect(contentLink?.parentElement?.closest("a")).toBeNull();
    expect(errors).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
