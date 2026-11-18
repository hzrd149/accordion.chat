import { expect, it } from "vitest";
import { BehaviorSubject } from "rxjs";
import type { Rumor } from "applesauce-core/helpers";
import type { ConcordCommunity } from "@applesauce/concord";
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
  const visible = rumors.filter((rumor) => rumor.kind === 9).map((rumor) => ({ rumor, content: rumor.content }));
  for (let i = 0; i < 20; i++) foldChannel(visible, rumors);
  const count = 100;
  const start = performance.now();
  for (let i = 0; i < count; i++) foldChannel(visible, rumors);
  const singleMs = (performance.now() - start) / count;
  const inputs$ = new BehaviorSubject(rumors);
  const channel = { id: "channel", messages$: new BehaviorSubject(visible), timeline$: () => inputs$ };
  const community = { channels$: new BehaviorSubject([channel]) } as unknown as ConcordCommunity;
  const views: unknown[] = [];
  const subs = Array.from({ length: 4 }, () => channelProjection(community, "channel").subscribe((v) => views.push(v)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(views.length).toBe(4);
  expect(views.every((v) => v === views[0])).toBe(true);
  subs.forEach((s) => s.unsubscribe());
  console.info(`2000 rumors: ${singleMs.toFixed(3)} ms/full fold; four mounted consumers perform 1 fold rather than 4`);
});
