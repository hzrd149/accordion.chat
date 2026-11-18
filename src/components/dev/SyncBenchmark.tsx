import { useEffect, useRef, useState } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useConcord } from "../../hooks/use-concord";
import { startConcordBenchmark } from "../../services/concord-benchmark";
import type { BenchmarkReport, BenchmarkTarget } from "../../services/concord-benchmark";
import { signatureVerificationMode$ } from "../../services/signature-verification";

const time = (ms?: number) => ms === undefined ? "—" : `${(ms / 1_000).toFixed(2)} s`;

export function SyncBenchmark() {
  const account = useActiveAccount();
  const client = useConcord();
  const communities = use$(() => client?.communities$, [client]) ?? [];
  const verification = use$(signatureVerificationMode$);
  const [source, setSource] = useState("list");
  const [invite, setInvite] = useState("");
  const [seconds, setSeconds] = useState(120);
  const [report, setReport] = useState<BenchmarkReport>();
  const [runs, setRuns] = useState<BenchmarkReport[]>([]);
  const [error, setError] = useState<string>();
  const active = useRef<ReturnType<typeof startConcordBenchmark> | undefined>(undefined);
  useEffect(() => () => { active.current?.cancel(); active.current = undefined; }, [account]);
  const running = report?.status === "running";
  function start() {
    if (!account || running) return;
    setError(undefined);
    let target: BenchmarkTarget;
    if (source === "list") target = { kind: "list" };
    else if (source === "invite") target = { kind: "invite", url: invite.trim() };
    else {
      const community = communities.find(({ material }) => material.community_id === source);
      if (!community) { setError("Select an available community."); return; }
      target = { kind: "community", material: community.material };
    }
    try {
      active.current = startConcordBenchmark(account, target, seconds * 1_000, (next) => {
        setReport(next);
        if (next.status !== "running") setRuns((previous) => [next, ...previous].slice(0, 10));
      });
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function downloadRuns() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "concord-cold-sync-benchmarks.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return (
    <div className="max-w-5xl flex flex-col gap-5">
      <p className="opacity-70">
        Benchmark cold community synchronization with fresh in-memory stores and new relay connections.
        Nothing is joined, saved to disk, or published. Historical backfill is always enabled; attachments and profiles are not downloaded.
      </p>
      <div className="alert alert-info text-sm">
        Full list includes relay discovery and signer decryption (which may prompt). A selected community reuses only its
        membership keys; an invite fetches its bundle without publishing a Join. Only history accessible to those keys can be tested.
        The normal app keeps running, so its network/CPU activity can affect results. Verification: {verification}.
        This is a cold data/client test, not a cold browser, DNS, TLS, or JavaScript startup test.
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 min-w-0">
          <span className="text-sm font-semibold">Source</span>
          <select className="select w-full max-w-96" value={source} disabled={running} onChange={(event) => setSource(event.target.value)}>
            <option value="list">Full community list (from relays)</option>
            <option value="invite">Invite link (read-only)</option>
            {communities.map(({ material, metadata }) => (
              <option key={material.community_id} value={material.community_id}>{metadata?.name ?? material.name ?? material.community_id}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-semibold">Timeout (seconds)</span>
          <input className="input w-32" type="number" min={1} max={900} value={seconds} disabled={running}
            onChange={(event) => setSeconds(Number(event.target.value))} />
        </label>
        <button className="btn btn-primary" disabled={!account || running || (source === "invite" && !invite.trim())} onClick={start}>
          {running ? "Benchmarking…" : "Start cold benchmark"}
        </button>
        {running && <button className="btn" onClick={() => active.current?.cancel()}>Cancel</button>}
      </div>
      {source === "invite" && <label className="flex flex-col gap-1">
        <span className="text-sm font-semibold">Invite link</span>
        <input className="input w-full" type="text" autoComplete="off" value={invite} disabled={running}
          placeholder="https://…/invite/…#…" onChange={(event) => setInvite(event.target.value)} />
      </label>}
      {(error || report?.error) && <div className="alert alert-error">{error ?? report?.error}</div>}
      {report && <>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`badge ${report.status === "complete" ? "badge-success" : "badge-outline"}`}>{report.status}</span>
          <strong>{time(report.elapsedMs)}</strong>
          {report.listKnowledge && <span className="text-sm opacity-60">List: {report.listKnowledge}</span>}
          {running && <span className="loading loading-spinner loading-sm" />}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          {[
            ["Client/engine start", time(report.startupMs)],
            ["First relay event", time(report.firstEventMs)],
            ["Received / unique outer events", `${report.receivedEvents} / ${report.uniqueEvents}`],
            ["EVENT payload", `${(report.receivedEventBytes / 1_048_576).toFixed(2)} MiB`],
            ["Outer events / second", (report.receivedEvents / Math.max(report.elapsedMs / 1_000, 0.001)).toFixed(1)],
            ["Max event-loop delay", `${Math.max(0, report.maxEventLoopLagMs).toFixed(0)} ms`],
          ].map(([label, value]) => <div key={label} className="rounded-box border border-base-300 p-3">
            <div className="opacity-60">{label}</div><strong>{value}</strong>
          </div>)}
        </div>
        <div className="overflow-x-auto">
          <table className="table table-sm">
            <thead><tr><th>Community</th><th>Phase</th><th>Live</th><th>Full coverage</th><th>Complete planes</th><th>Retained routes</th></tr></thead>
            <tbody>{report.communities.map((row) => <tr key={row.id}>
              <td>{row.name}</td><td>{row.phase}</td><td>{time(row.liveMs)}</td><td>{time(row.completeMs)}</td>
              <td>{row.completePlanes} / {row.planes}</td><td>{row.retained}</td>
            </tr>)}</tbody>
          </table>
        </div>
        <p className="text-sm opacity-60">
          Completion requires the full list (when selected), live community engines and complete current/history plane coverage,
          stable for one second. Failed or incomplete reads never count as complete; a timeout is a partial result.
          Times are from the start of the run. Payload bytes include duplicate EVENT deliveries, not WebSocket overhead.
          Retained routes are SDK processing counts, not unique visible messages. Event-loop delay is tab-wide, not isolated CPU time.
          For comparable timings, use a production build and keep this tab in the foreground. Measurements include instrumentation overhead.
        </p>
        {Object.keys(report.diagnostics).length > 0 && <div className="alert alert-warning text-sm">
          Diagnostics: {Object.entries(report.diagnostics).map(([stage, count]) => `${stage}: ${count}`).join(", ")}
        </div>}
      </>}
      {runs.length > 0 && <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold">Recent runs (this view only)</h3>
          <button className="btn btn-sm btn-ghost" onClick={downloadRuns}>Download results (JSON)</button>
        </div>
        {runs.map((run, index) => <div key={`${run.startedAt}-${index}`} className="text-sm flex flex-wrap gap-3">
          <span>{new Date(run.startedAt).toLocaleTimeString()}</span><span>{run.source}</span>
          <span>{run.status}</span><span>{time(run.elapsedMs)}</span><span>{run.receivedEvents} events</span>
          <span>{run.verification} verification</span>
        </div>)}
      </div>}
    </div>
  );
}
