import { afterEach, describe, expect, it, vi } from "vitest";
import { BehaviorSubject, defer, finalize } from "rxjs";
import type { Rumor } from "applesauce-core/helpers";
import type { ConcordCommunity, CommunityState } from "@applesauce/concord";
import { nip19 } from "nostr-tools";
import { summarize } from "../src/chat/useUnread";
import { collectMentions } from "../src/chat/useMentions";
import { foldChannel } from "../src/chat/fold";
import { channelProjection } from "../src/chat/projection";

const rumor = (id: string, kind = 9, pubkey = "author", tags: string[][] = [], content = id, time = 1): Rumor =>
  ({ id, kind, pubkey, tags, content, created_at: time });
const comment = (id: string) => rumor(id, 1111, "reader", [
  ["E", "message", "", "author"], ["K", "9"], ["P", "author"],
  ["e", "message", "", "author"], ["k", "9"], ["p", "author"],
]);

describe("channel visibility projection", () => {
  afterEach(() => vi.useRealTimers());
  it("applies deletes to reactions and NIP-22 replies as well as messages", () => {
    const input = [rumor("message"), comment("reply"),
      rumor("react", 7, "reader", [["e", "message"]], "👍"),
      rumor("delete", 5, "reader", [["e", "reply"], ["e", "react"]])];
    const view = foldChannel(input);
    expect(view.messages[0].threadReplyCount).toBe(0);
    expect(view.messages[0].reactions).toEqual([]);
    expect(view.threads.size).toBe(0);
  });

  it("restores effects from retained inputs when moderator authority is revoked", () => {
    const input = [rumor("message"), comment("reply"), rumor("delete", 5, "moderator", [["e", "message"]])];
    const hidden = foldChannel(input, () => true);
    expect(hidden.messages[0].deleted).toBe(true);
    expect(hidden.threads.size).toBe(0);
    const restored = foldChannel(input);
    expect(restored.messages[0].deleted).toBe(false);
    expect(restored.messages[0].threadReplyCount).toBe(1);
  });

  it("selects the newest author edit independent of arrival order, excluding deleted edits", () => {
    const input = [rumor("message"), rumor("new", 3302, "author", [["e", "message"]], "new", 3),
      rumor("old", 3302, "author", [["e", "message"]], "old", 2),
      rumor("forged", 3302, "attacker", [["e", "message"]], "forged", 4)];
    expect(foldChannel(input).messages[0].edited).toBe("new");
    expect(foldChannel([...input, rumor("delete", 5, "author", [["e", "new"]])]).messages[0].edited).toBe("old");
  });

  it("keeps unread badges and mention rows aligned with edits and deletes", () => {
    const pubkey = "a".repeat(64);
    const mention = `nostr:${nip19.npubEncode(pubkey)}`;
    const base = [rumor("message", 9, "author", [], "hello"),
      rumor("edit", 3302, "author", [["e", "message"]], mention, 2)];
    const messages = foldChannel(base).messages;
    expect(summarize(messages, 0, pubkey)).toEqual({ count: 1, mention: true });
    expect(collectMentions([["channel", messages]], pubkey).map((r) => r.content)).toEqual([mention]);
    const removedMention = foldChannel([...base,
      rumor("newEdit", 3302, "author", [["e", "message"]], "no mention", 3)]).messages;
    expect(summarize(removedMention, 0, pubkey)).toEqual({ count: 1, mention: false });
    expect(collectMentions([["channel", removedMention]], pubkey)).toEqual([]);
    const deleted = foldChannel([...base, rumor("delete", 5, "author", [["e", "message"]])]).messages;
    expect(summarize(deleted, 0, pubkey)).toEqual({ count: 0, mention: false });
    expect(collectMentions([["channel", deleted]], pubkey)).toEqual([]);
  });

  it("shares one source and fold and invalidates authority without new chat", async () => {
    vi.useFakeTimers();
    let subscriptions = 0;
    let active = 0;
    let allowed = false;
    const state = { roles: [], grants: new Map(), banlist: new Set(), material: {}, controlVerification: {} };
    const state$ = new BehaviorSubject(state as unknown as CommunityState);
    const inputs$ = new BehaviorSubject([rumor("message"), rumor("delete", 5, "moderator", [["e", "message"]])]);
    const community = {
      state$, channelTimeline: () => defer(() => {
        subscriptions++; active++;
        return inputs$.pipe(finalize(() => active--));
      }),
      standingOf: () => ({ position: 100 }), admin: { hasPerm: () => allowed },
    } as unknown as ConcordCommunity;
    const views: boolean[] = [];
    const source = channelProjection(community, "channel");
    const a = source.subscribe((v) => views.push(v.messages[0].deleted));
    const b = channelProjection(community, "channel").subscribe();
    expect(subscriptions).toBe(1);
    await vi.runAllTimersAsync();
    allowed = true;
    state$.next({ ...state$.value, controlVerification: {} } as CommunityState);
    await vi.runAllTimersAsync();
    expect(views).toEqual([false, true]);
    state$.next({ ...state$.value, members: new Set(["new arrival"]) });
    await vi.runAllTimersAsync();
    expect(views).toEqual([false, true]);
    // A synchronous cache hydration burst needs only one additional fold.
    for (let i = 0; i < 100; i++) inputs$.next([...inputs$.value]);
    await vi.runAllTimersAsync();
    expect(views).toEqual([false, true, true]);
    a.unsubscribe(); b.unsubscribe();
    expect(active).toBe(0);
  });
});
