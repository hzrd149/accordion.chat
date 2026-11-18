import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ConcordChannelDraft, Drafts } from "@applesauce/concord";
import { useChannelDraft } from "../src/hooks/use-channel-draft";

// Mount only the hook's synchronous write boundary; loading/rendering is not
// under test. Refs retain edits while async SDK persistence/publication waits.
function fixture() {
  const set = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const clear = vi.fn().mockResolvedValue(undefined);
  const draft = { set, send, clear, load: vi.fn() } as unknown as ConcordChannelDraft;
  let result!: ReturnType<typeof useChannelDraft>;
  function Probe() {
    result = useChannelDraft(draft);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return { controls: result, set, send, clear };
}

describe("channel draft publication boundary", () => {
  it("persists thread emoji definitions before invoking the SDK sender", async () => {
    const { controls, set, send } = fixture();
    const emojis = [{ shortcode: "wave", url: "https://example.com/wave.png" }];
    controls.update({ text: "Hello :wave:", emojis });
    await controls.send();
    expect(set).toHaveBeenLastCalledWith({ text: "Hello :wave:", files: [], emojis });
    expect(send).toHaveBeenCalledWith(undefined);
    expect(set.mock.invocationCallOrder.at(-1)).toBeLessThan(send.mock.invocationCallOrder[0]);
  });

  it("passes one complete snapshot to the attachment adapter and keeps newer typing", async () => {
    const { controls, set, send, clear } = fixture();
    const files = [new File(["image"], "image.png")];
    const emojis = [{ shortcode: "wave", url: "https://example.com/wave.png" }];
    controls.update({ text: "Original :wave:", files, emojis });
    let finish!: () => void;
    const publish = vi.fn<(snapshot: Readonly<Drafts.ConcordMessageDraft>) => Promise<void>>(() =>
      new Promise<void>((resolve) => { finish = resolve; }));
    const sending = controls.send(undefined, publish);
    // Type while the initial durable set is pending, before publication starts.
    controls.update({ text: "Next reply", files: [] });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith({ text: "Original :wave:", files, emojis });
    expect(set).toHaveBeenLastCalledWith({ text: "Next reply", files: [], emojis });
    finish();
    await sending;
    expect(send).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it("retains a failed attachment draft", async () => {
    const { controls, clear } = fixture();
    controls.update({ text: "Retry me" });
    await expect(controls.send(undefined, async () => { throw new Error("Upload failed"); }))
      .rejects.toThrow("Upload failed");
    expect(clear).not.toHaveBeenCalled();
  });
});
