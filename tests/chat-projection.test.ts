import { afterEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, defer, finalize } from "rxjs";
import type { Rumor } from "applesauce-core/helpers";
import type { ConcordChannelMessage, ConcordCommunity } from "@applesauce/concord";
import { nip19 } from "nostr-tools";
import { summarize } from "../src/chat/useUnread";
import { collectMentions } from "../src/chat/useMentions";
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
    expect(views).toEqual([1, 0, 1, 1]);
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
