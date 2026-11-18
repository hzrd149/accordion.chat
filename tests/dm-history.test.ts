import { describe, expect, it, vi } from "vitest";
import type { WrappedMessagesSyncStatus } from "applesauce-extra/messages";
import { createInboxHistory, HISTORY_SPAN } from "../src/messages/history";

const NOW = 1_800_000_000;
type RelayState = "complete" | "error" | "skipped";
function status(loaded: number, states: RelayState[] = ["complete"]): WrappedMessagesSyncStatus {
  const relays = Object.fromEntries(states.map((state, index) => [`wss://r${index}`, {
    relay: `wss://r${index}`, state, ...(state === "complete" ? {} : { error: new Error("offline") }),
  }]));
  return { done: true, loaded, mailboxes: [{ relays, done: true, loaded } as never] };
}
function source(...results: Array<WrappedMessagesSyncStatus | Error>) {
  const loadHistory = vi.fn(async () => {
    const next = results.shift() ?? status(0);
    if (next instanceof Error) throw next;
    return next;
  });
  return { loadHistory };
}

describe("inbox history coverage", () => {
  it("starts at the client's initial lookback and steps back one span at a time", async () => {
    const client = source(status(3), status(1));
    const history = createInboxHistory(client, NOW);
    expect(history.state$.value).toMatchObject({ coverage: NOW - HISTORY_SPAN, done: false });
    await history.extend();
    expect(client.loadHistory).toHaveBeenLastCalledWith({ since: NOW - 2 * HISTORY_SPAN, until: NOW - HISTORY_SPAN });
    await history.extend();
    expect(client.loadHistory).toHaveBeenLastCalledWith({ since: NOW - 3 * HISTORY_SPAN, until: NOW - 2 * HISTORY_SPAN });
    expect(history.state$.value.coverage).toBe(NOW - 3 * HISTORY_SPAN);
  });

  it("shares one load between concurrent callers", async () => {
    const client = source(status(1));
    const history = createInboxHistory(client, NOW);
    await Promise.all([history.extend(), history.extend(), history.extend()]);
    expect(client.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("doubles the step across empty slices, then reaches the beginning of time", async () => {
    const client = source();
    const history = createInboxHistory(client, NOW);
    while (!history.state$.value.done) await history.extend();
    const spans = client.loadHistory.mock.calls.map(([options]) => options!.until! - options!.since!);
    expect(spans.slice(0, 3)).toEqual([HISTORY_SPAN, 2 * HISTORY_SPAN, 4 * HISTORY_SPAN]);
    expect(client.loadHistory.mock.calls.at(-1)![0]!.since).toBe(0);
    expect(client.loadHistory.mock.calls.length).toBeLessThan(10);
    await history.extend();
    expect(client.loadHistory.mock.calls.length).toBeLessThan(10);
  });

  it("resets the step once a slice finds envelopes", async () => {
    const client = source(status(0), status(5), status(0));
    const history = createInboxHistory(client, NOW);
    await history.extend();
    await history.extend();
    await history.extend();
    const spans = client.loadHistory.mock.calls.map(([options]) => options!.until! - options!.since!);
    expect(spans).toEqual([HISTORY_SPAN, 2 * HISTORY_SPAN, HISTORY_SPAN]);
  });

  it("keeps coverage when every relay or the load fails, and advances on partial failure", async () => {
    const client = source(status(0, ["error", "skipped"]), new Error("aborted"), status(2, ["complete", "error"]));
    const history = createInboxHistory(client, NOW);
    await history.extend();
    expect(history.state$.value).toMatchObject({ coverage: NOW - HISTORY_SPAN, loading: false, error: expect.stringContaining("offline") });
    await history.extend();
    expect(history.state$.value).toMatchObject({ coverage: NOW - HISTORY_SPAN, error: "aborted" });
    await history.extend();
    expect(history.state$.value).toMatchObject({ coverage: NOW - 2 * HISTORY_SPAN, error: expect.stringContaining("wss://r1") });
  });
});
