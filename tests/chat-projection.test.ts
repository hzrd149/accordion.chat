import { afterEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, defer, finalize } from "rxjs";
import type { Rumor } from "applesauce-core/helpers";
import type { ConcordChannelMessage, ConcordCommunity } from "@applesauce/concord";
import { nip19, type EventTemplate } from "nostr-tools";
import { summarize } from "../src/chat/useUnread";
import { collectMentions } from "../src/chat/useMentions";
import { sendThreadReply } from "../src/chat/actions";
import { foldChannel } from "../src/chat/fold";
import { channelProjection } from "../src/chat/projection";

const rumor = (id: string, kind = 9, tags: string[][] = [], content = id): Rumor =>
  ({ id, kind, pubkey: "author", tags, content, created_at: 1 });
const row = (r: Rumor): ConcordChannelMessage => ({ rumor: r, content: r.content });
const reply = rumor("reply", 1111, [
  ["E", "message", "", "author"], ["K", "9"], ["P", "author"],
  ["e", "message", "", "author"], ["k", "9"], ["p", "author"],
]);

describe("SDK channel presentation adapter", () => {
  afterEach(() => vi.useRealTimers());

  it("keeps authenticated originals while using SDK edits for text, emoji and mentions", () => {
    const pubkey = "a".repeat(64);
    const content = `nostr:${nip19.npubEncode(pubkey)}`;
    const original = rumor("message");
    const edit = rumor("edit", 3302, [["emoji", "party", "https://example.com/party.png"]], content);
    const visible = [{ rumor: original, edit, content }];
    const messages = foldChannel(visible, []).messages;
    expect(messages[0].raw).toBe(original);
    expect(messages[0].content).toBe("message");
    expect(messages[0].edited).toBe(content);
    expect(messages[0].emojiTags).toEqual(edit.tags);
    expect(summarize(messages, 0, pubkey)).toEqual({ count: 1, mention: true });
    expect(collectMentions([["channel", messages]], pubkey)[0].content).toBe(content);
    expect(summarize(foldChannel([], []).messages, 0, pubkey)).toEqual({ count: 0, mention: false });
  });

  it("groups visible reactions and threaded replies without retaining hidden roots", () => {
    const reactions = [rumor("react", 7, [["e", "message"]], "👍"), rumor("duplicate", 7, [["e", "message"]], "👍")];
    const view = foldChannel([row(rumor("message")), { ...row(reply), content: "edited reply" }], reactions);
    expect(view.messages[0].threadReplyCount).toBe(1);
    expect(view.messages[0].reactions[0].count).toBe(1);
    expect(view.threads.get("message")?.[0].content).toBe("edited reply");
    expect(foldChannel([row(reply)], reactions).threads.size).toBe(0);
    const removed = foldChannel([row(rumor("message"))], [
      ...reactions, rumor("delete", 5, [["e", "react"], ["e", "duplicate"]]),
    ]);
    expect(removed.messages[0].reactions).toEqual([]);
  });

  it("preserves unchanged rows, attachment metadata, and thread arrays across updates", () => {
    const message = row(rumor("message"));
    const other = row(rumor("other"));
    const comment = row(reply);
    const initial = foldChannel([message, other, comment], []);
    expect(foldChannel([message, other, comment], [], initial)).toBe(initial);

    const reaction = rumor("react", 7, [["e", "message"]], "👍");
    const reacted = foldChannel([message, other, comment], [reaction], initial);
    expect(reacted.messages[0]).not.toBe(initial.messages[0]);
    expect(reacted.messages[0].attachments).toBe(initial.messages[0].attachments);
    expect(reacted.messages[1]).toBe(initial.messages[1]);
    expect(reacted.threads).toBe(initial.threads);

    const edit = rumor("edit", 3302, [], "edited");
    const edited = foldChannel([message, other, { ...comment, edit, content: "edited" }], [reaction], reacted);
    expect(edited.messages).toBe(reacted.messages);
    expect(edited.threads.get("message")?.[0].content).toBe("edited");
    expect(edited.threads.get("message")?.[0].attachments).toBe(initial.threads.get("message")?.[0].attachments);

    const removed = foldChannel([other], [], edited);
    expect(removed.messages).toEqual([initial.messages[1]]);
    expect(removed.threads.size).toBe(0);
  });

  it("updates aggregates without mutating previous snapshots or replacing unchanged reaction arrays", () => {
    const message = row(rumor("message"));
    const reaction = rumor("reaction", 7, [["e", "message"]], "👍");
    const initial = foldChannel([message], [reaction]);
    const withReply = foldChannel([message, row(reply)], [reaction], initial);
    expect(initial.messages[0].threadReplyCount).toBe(0);
    expect(withReply.messages[0].threadReplyCount).toBe(1);
    expect(withReply.messages[0].reactions).toBe(initial.messages[0].reactions);

    const otherAuthor = { ...reaction, id: "second", pubkey: "other" };
    const reacted = foldChannel([message, row(reply)], [reaction, otherAuthor], withReply);
    expect(withReply.messages[0].reactions[0].authors).toEqual(["author"]);
    expect(reacted.messages[0].reactions[0].authors).toEqual(["author", "other"]);
    expect(reacted.threads).toBe(withReply.threads);

    const removed = foldChannel([message], [], reacted);
    expect(removed.messages[0].reactions).toEqual([]);
    expect(removed.messages[0].threadReplyCount).toBe(0);
    expect(reacted.messages[0].threadReplyCount).toBe(1);
  });

  it("skips folding 5000 equivalent SDK rows across tasks but observes edits, effects and removals", async () => {
    vi.useFakeTimers();
    const visible = Array.from({ length: 5000 }, (_, index) => row(rumor(`message-${index}`)));
    // Tag parsing is part of the fold, not the input equality check.
    const parseTags = vi.spyOn(visible[0].rumor.tags, "filter");
    const messages$ = new BehaviorSubject(visible);
    const effects$ = new BehaviorSubject<Rumor[]>([]);
    const channel = { id: "channel", messages$, timeline$: () => effects$ };
    const community = { channels$: new BehaviorSubject([channel]) } as unknown as ConcordCommunity;
    const views: ReturnType<typeof foldChannel>[] = [];
    const sub = channelProjection(community, "channel").subscribe((view) => views.push(view));
    await vi.runAllTimersAsync();
    parseTags.mockClear();
    for (let i = 0; i < 5; i++) {
      messages$.next(visible.map((message) => ({ ...message })));
      effects$.next([]);
      await vi.runAllTimersAsync();
    }
    expect(views).toHaveLength(1);
    expect(parseTags).not.toHaveBeenCalled();

    const edit = rumor("edit", 3302, [["emoji", "party", "https://example.com/party.png"]], "edited");
    messages$.next([{ ...visible[0], edit, content: edit.content }, ...visible.slice(1)]);
    await vi.runAllTimersAsync();
    expect(views.at(-1)?.messages[0].edited).toBe("edited");
    expect(views.at(-1)?.messages[0].emojiTags).toEqual(edit.tags);
    effects$.next([rumor("react", 7, [["e", "message-0"]], "👍")]);
    await vi.runAllTimersAsync();
    expect(views.at(-1)?.messages[0].reactions[0].count).toBe(1);
    expect(views.at(-1)?.messages[1]).toBe(views[0].messages[1]);
    messages$.next([]);
    await vi.runAllTimersAsync();
    expect(views.at(-1)?.messages).toEqual([]);
    sub.unsubscribe();
    parseTags.mockRestore();
  });

  it("publishes and projects an encrypted attachment in a nested, media-only reply", async () => {
    const attachment = {
      url: "https://example.com/blob",
      type: "image/png",
      encryption: { algorithm: "aes-gcm", key: "a".repeat(64), nonce: "b".repeat(32) },
    };
    const sendEvent = vi.fn(async (_channelId: string, event: EventTemplate) => event);
    const upload = vi.fn().mockResolvedValue(attachment);
    const community = {
      communityId: "community",
      state$: { value: { channels: [{ channel_id: "channel", private: false }] } },
      channelStore: () => ({ getEvent: async () => reply }),
      sendEvent,
    } as unknown as ConcordCommunity;
    const files = [new File(["image"], "image.png", { type: "image/png" })];
    const media = { files, uploader: { upload }, onProgress: vi.fn() };

    await sendThreadReply(community, "channel", { id: reply.id, author: reply.pubkey, kind: reply.kind }, "", undefined, media);

    const event = sendEvent.mock.calls[0][1];
    expect(event.kind).toBe(1111);
    expect(event.content).toBe(attachment.url);
    const nestedReply = rumor("nested", event.kind, event.tags, event.content);
    const projected = foldChannel([row(rumor("message")), row(reply), row(nestedReply)], [])
      .threads.get("message")?.find((comment) => comment.id === nestedReply.id);
    expect(projected?.parent.id).toBe(reply.id);
    expect(projected?.attachments[0]).toMatchObject(attachment);

    upload.mockRejectedValueOnce(new Error("Upload failed"));
    await expect(sendThreadReply(community, "channel", { id: reply.id, author: reply.pubkey, kind: reply.kind }, "", undefined, media))
      .rejects.toThrow("Upload failed");
    expect(sendEvent).toHaveBeenCalledTimes(1);
  });

  it("shares SDK subscriptions and follows removals/restorations without a second authority fold", async () => {
    vi.useFakeTimers();
    let active = 0;
    const messages$ = new BehaviorSubject([row(rumor("message"))]);
    const reactions$ = new BehaviorSubject<Rumor[]>([]);
    const channel = {
      id: "channel",
      messages$: defer(() => { active++; return messages$.pipe(finalize(() => active--)); }),
      timeline$: () => defer(() => { active++; return reactions$.pipe(finalize(() => active--)); }),
    };
    const community = { channels$: new BehaviorSubject([channel]) } as unknown as ConcordCommunity;
    const views: number[] = [];
    const a = channelProjection(community, "channel").subscribe((view) => views.push(view.messages.length));
    const b = channelProjection(community, "channel").subscribe();
    expect(active).toBe(2);
    await vi.runAllTimersAsync();
    messages$.next([]);
    await vi.runAllTimersAsync();
    messages$.next([row(rumor("message"))]);
    await vi.runAllTimersAsync();
    expect(views).toEqual([1, 0, 1]);
    for (let i = 0; i < 100; i++) messages$.next([...messages$.value]);
    await vi.runAllTimersAsync();
    // Equivalent SDK emissions are coalesced without notifying React again.
    expect(views).toEqual([1, 0, 1]);
    a.unsubscribe(); b.unsubscribe();
    expect(active).toBe(0);
  });

  it("waits for a channel discovered during sync and releases it when removed", async () => {
    vi.useFakeTimers();
    const channel = { id: "channel", messages$: new BehaviorSubject([row(rumor("message"))]),
      timeline$: () => new BehaviorSubject<Rumor[]>([]) };
    const channels$ = new BehaviorSubject<typeof channel[]>([]);
    const community = { channels$ } as unknown as ConcordCommunity;
    const views: number[] = [];
    const sub = channelProjection(community, "channel").subscribe((view) => views.push(view.messages.length));
    await vi.runAllTimersAsync();
    channels$.next([channel]);
    await vi.runAllTimersAsync();
    channels$.next([]);
    await vi.runAllTimersAsync();
    expect(views).toEqual([0, 1, 0]);
    sub.unsubscribe();
  });
});
