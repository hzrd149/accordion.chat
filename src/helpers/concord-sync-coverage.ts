import type { ConcordPlaneSyncCoverage } from "@applesauce/concord";

/** Finite reads reported so far, not a promise that no more history will be discovered. */
export function summarizeSyncCoverage(
  coverage: ReadonlyMap<string, ConcordPlaneSyncCoverage>,
  lane: ConcordPlaneSyncCoverage["lane"],
) {
  const summary = { total: 0, complete: 0, syncing: 0, incomplete: 0, error: 0, retained: 0 };
  for (const plane of coverage.values()) {
    if (plane.lane !== lane) continue;
    summary.total++;
    summary[plane.state]++;
    summary.retained += plane.retained;
  }
  return summary;
}
