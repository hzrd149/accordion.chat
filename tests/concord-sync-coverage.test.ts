import type { ConcordPlaneSyncCoverage } from "@applesauce/concord";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BehaviorSubject } from "rxjs";
import type { Observable } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { summarizeSyncCoverage } from "../src/helpers/concord-sync-coverage";
import { ConcordDataCoverage } from "../src/components/ConcordDataCoverage";

vi.mock("applesauce-react/hooks", () => ({
  use$: (factory: () => Observable<unknown>) => {
    let value: unknown;
    const subscription = factory().subscribe((next) => { value = next; });
    subscription.unsubscribe();
    return value;
  },
}));

function plane(
  author: string,
  lane: ConcordPlaneSyncCoverage["lane"],
  state: ConcordPlaneSyncCoverage["state"],
  retained = 0,
): ConcordPlaneSyncCoverage {
  return { author, lane, state, retained, relays: {} };
}
const coverage = (...planes: ConcordPlaneSyncCoverage[]) => new Map(planes.map((entry) => [entry.author, entry]));
const html = (entries: ReadonlyMap<string, ConcordPlaneSyncCoverage>, historyEnabled = true) =>
  renderToStaticMarkup(createElement(ConcordDataCoverage, {
    community: { syncCoverage$: new BehaviorSubject(entries) },
    historyEnabled,
  }));

describe("Concord data coverage presentation", () => {
  it("keeps current reads independent of slow or failing historical reads", () => {
    const entries = coverage(
      plane("current", "current", "complete", 5),
      plane("old", "history", "syncing", 3),
      plane("older", "history", "error", 2),
    );
    expect(summarizeSyncCoverage(entries, "current")).toEqual({
      total: 1, complete: 1, syncing: 0, incomplete: 0, error: 0, retained: 5,
    });
    expect(summarizeSyncCoverage(entries, "history")).toEqual({
      total: 2, complete: 0, syncing: 1, incomplete: 0, error: 1, retained: 5,
    });
    const output = html(entries);
    expect(output).toContain("Reported reads complete");
    expect(output).toContain("Loading");
    expect(output).toContain("1 failed");
    expect(output).not.toContain("Up to date");
  });

  it("does not treat an empty map as completed history", () => {
    expect(html(coverage())).toContain("No reads reported yet");
    expect(html(coverage())).not.toContain("Reported reads complete");
    expect(html(coverage(), false)).toContain("Automatic backfill off");
  });

  it("does not infer completion from received events or a successful peer", () => {
    const partial = plane("partial", "current", "incomplete", 42);
    partial.relays = { "wss://ok.example": { state: "complete" }, "wss://bad.example": { state: "error" } };
    const output = html(coverage(partial));
    expect(output).toContain("Partial coverage");
    expect(output).toContain("0 of 1 reported plane reads complete");
    expect(output).toContain("42 retained events");
  });

  it("shows failed reads and limits completion claims to discovered planes", () => {
    const output = html(coverage(plane("old", "history", "error")));
    expect(output).toContain("Read failed");
    expect(output).toContain("not private-channel history");
    expect(output).toContain("may grow");
    expect(output).not.toContain("Reported reads complete");
  });

  it("allows forward-session reads to finish even with automatic backfill off", () => {
    const output = html(coverage(plane("prior-current", "history", "syncing")), false);
    expect(output).toContain("Loading");
    expect(output).toContain("earlier live-session reads may still finish");
  });

  it("counts successful empty relay reads as complete, not as loading", () => {
    const summary = summarizeSyncCoverage(coverage(plane("empty", "current", "complete")), "current");
    expect(summary).toMatchObject({ total: 1, complete: 1, retained: 0, syncing: 0 });
  });
});
