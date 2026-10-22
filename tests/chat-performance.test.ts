import { expect, it } from "vitest";
import { BehaviorSubject } from "rxjs";
import type { Rumor } from "applesauce-core/helpers";
import type { ConcordCommunity, CommunityState } from "@applesauce/concord";
import { foldChannel } from "../src/chat/fold";
import { channelProjection } from "../src/chat/projection";

// Repeatable representative full-cache workload, not a machine-specific timing gate.
it("profiles a 2000-rumor channel and verifies four consumers share identical projections", async () => {
  const rumors: Rumor[] = Array.from({ length: 1600 }, (_, i) => ({
    id: `message-${i}`, kind: 9, pubkey: `author-${i % 20}`, content: `Message ${i}`,
    created_at: 1000 + i, tags: [],
  }));
  for (let i = 0; i < 200; i++) {
    rumors.push({ id: `reaction-${i}`, kind: 7, pubkey: `author-${i % 20}`, content: "👍",
      created_at: 3000 + i, tags: [["e", `message-${i}`]] });
    rumors.push({ id: `edit-${i}`, kind: 3302, pubkey: `author-${i % 20}`, content: `Edited ${i}`,
      created_at: 4000 + i, tags: [["e", `message-${i}`]] });
  }
  for (let i = 0; i < 20; i++) foldChannel(rumors);
  const count = 100;
  const start = performance.now();
  for (let i = 0; i < count; i++) foldChannel(rumors);
  const singleMs = (performance.now() - start) / count;
  const state$ = new BehaviorSubject({ roles: [], grants: new Map(), banlist: new Set(), material: {} } as unknown as CommunityState);
  const inputs$ = new BehaviorSubject(rumors);
  const community = { state$, channelTimeline: () => inputs$, admin: { hasPerm: () => false } } as unknown as ConcordCommunity;
  const views: unknown[] = [];
  const subs = Array.from({ length: 4 }, () => channelProjection(community, "channel").subscribe((v) => views.push(v)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(views.length).toBe(4);
  expect(views.every((v) => v === views[0])).toBe(true);
  subs.forEach((s) => s.unsubscribe());
  console.info(`2000 rumors: ${singleMs.toFixed(3)} ms/full fold; four mounted consumers perform 1 fold rather than 4`);
});
