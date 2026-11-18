import type { ConcordCommunity, ConcordPlaneSyncCoverage } from "@applesauce/concord";
import { use$ } from "applesauce-react/hooks";
import { Loader2 } from "lucide-react";
import { asyncScheduler, throttleTime } from "rxjs";
import { summarizeSyncCoverage } from "../helpers/concord-sync-coverage";

const EMPTY = new Map<string, ConcordPlaneSyncCoverage>();

/** Subscribe only in this panel: background progress must not rerender chat or its composer. */
export function ConcordDataCoverage({ community, historyEnabled }: {
  community: Pick<ConcordCommunity, "syncCoverage$">;
  historyEnabled: boolean;
}) {
  const coverage = use$(() => community.syncCoverage$.pipe(
    throttleTime(150, asyncScheduler, { leading: true, trailing: true }),
  ), [community]) ?? EMPTY;
  return (
    <section className="space-y-3 border-t border-base-300 p-4">
      <h3 className="font-semibold">Message and membership data</h3>
      <p className="text-base-content/70">
        Live readiness is separate from data loading. Messages and membership can continue arriving while the community is live.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {(["current", "history"] as const).map((lane) => {
          const summary = summarizeSyncCoverage(coverage, lane);
          const label = summary.syncing ? "Loading"
            : summary.error ? "Read failed"
            : summary.incomplete ? "Partial coverage"
            : summary.total ? "Reported reads complete"
            : lane === "history" && !historyEnabled ? "Automatic backfill off" : "No reads reported yet";
          const tone = summary.error || summary.incomplete ? "badge-warning"
            : summary.syncing ? "badge-info" : "badge-ghost";
          return (
            <div key={lane} className="min-w-0 space-y-2 rounded-box bg-base-200 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="font-medium">{lane === "current" ? "Current data" : "Older history"}</h4>
                <span className={`badge badge-soft h-auto py-1 ${tone}`}>
                  {summary.syncing > 0 && <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />}
                  {label}
                </span>
              </div>
              {summary.total > 0 && <>
                <p>{summary.complete} of {summary.total} reported plane reads complete · {summary.retained} retained events</p>
                <p className="text-base-content/70">
                  {summary.syncing} loading · {summary.incomplete} incomplete · {summary.error} failed
                </p>
              </>}
              {lane === "history" && !historyEnabled && summary.total > 0 &&
                <p className="text-base-content/70">Automatic older-history backfill is off; earlier live-session reads may still finish.</p>}
            </div>
          );
        })}
      </div>
      <p className="text-base-content/70">
        Coverage reports community membership and public-channel reads, not private-channel history.
        Counts cover discovered reads only and may grow as older keys and channels are resolved.
        Incomplete reads can mean a relay failed even when other relays returned data.
      </p>
    </section>
  );
}
