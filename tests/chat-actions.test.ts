import { describe, expect, it, vi } from "vitest";
import type { ConcordCommunity, Media } from "@applesauce/concord";
import type { Rumor } from "applesauce-common/helpers";
import { sendEditWithEmojis, sendThreadReply } from "../src/chat/actions";

const emojis = [{ shortcode: "wave", url: "https://example.com/wave.png" }];
const parent: Rumor = {
  id: "1".repeat(64), pubkey: "2".repeat(64), kind: 9,
  content: "Thread root", created_at: 123, tags: [],
};
const target = { id: parent.id, author: parent.pubkey, kind: parent.kind };

function fixture() {
  const getEvent = vi.fn().mockResolvedValue(parent);
  const replyToThread = vi.fn().mockResolvedValue(undefined);
  const editMessage = vi.fn().mockResolvedValue(undefined);
  const sendEvent = vi.fn().mockResolvedValue("sent");
  const community = {
    communityId: "community",
    channelStore: vi.fn(() => ({ getEvent })),
    replyToThread, editMessage, sendEvent,
    state$: { value: { channels: [{ channel_id: "channel", private: false }] } },
  } as unknown as ConcordCommunity;
  return { community, getEvent, replyToThread, editMessage, sendEvent };
}

describe("chat messaging adapters", () => {
  it.each([undefined, emojis])("delegates text replies and emoji definitions to the SDK (%j)", async (definitions) => {
    const { community, replyToThread, sendEvent } = fixture();
    await sendThreadReply(community, "channel", target, "Hello :wave:", definitions);
    expect(replyToThread).toHaveBeenCalledWith("channel", parent, "Hello :wave:", definitions);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("rejects an unavailable parent without publishing", async () => {
    const { community, getEvent, replyToThread, sendEvent } = fixture();
    getEvent.mockResolvedValue(undefined);
    await expect(sendThreadReply(community, "channel", target, "Hello", emojis))
      .rejects.toThrow("Reply target is not loaded");
    expect(replyToThread).not.toHaveBeenCalled();
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("delegates edits so the SDK owns target kind and expiration preservation", async () => {
    const { community, editMessage, sendEvent } = fixture();
    await sendEditWithEmojis(community, "channel", parent.id, "Edited :wave:", emojis);
    expect(editMessage).toHaveBeenCalledWith("channel", parent.id, "Edited :wave:", emojis);
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it("propagates SDK edit failures", async () => {
    const { community, editMessage } = fixture();
    editMessage.mockRejectedValue(new Error("Target expired"));
    await expect(sendEditWithEmojis(community, "channel", parent.id, "Edited", emojis))
      .rejects.toThrow("Target expired");
  });

  it("keeps encrypted attachment replies on the narrow factory adapter", async () => {
    const { community, replyToThread, sendEvent } = fixture();
    const attachment = {
      url: "https://example.com/encrypted", type: "image/png",
      encryption: { algorithm: "aes-gcm", key: "a".repeat(64), nonce: "b".repeat(24) },
    };
    const upload = vi.fn().mockResolvedValue(attachment);
    const onProgress = vi.fn();
    const file = new File(["image"], "image.png", { type: "image/png" });
    await sendThreadReply(community, "channel", target, "Hello :wave:", emojis, {
      files: [file], uploader: { upload } as Media.ConcordUploader, onProgress,
    });
    expect(upload).toHaveBeenCalledWith(file, "community", expect.objectContaining({ onProgress: expect.any(Function) }));
    expect(replyToThread).not.toHaveBeenCalled();
    expect(sendEvent).toHaveBeenCalledWith("channel", expect.objectContaining({
      kind: 1111,
      content: `Hello :wave:\n${attachment.url}`,
      tags: expect.arrayContaining([
        ["emoji", "wave", emojis[0].url],
        expect.arrayContaining(["imeta", `url ${attachment.url}`]),
      ]),
    }), {});
    expect(onProgress).toHaveBeenLastCalledWith({ total: 1, done: 1, phase: "uploading" });
  });
});
