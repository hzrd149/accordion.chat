import type { ISigner } from "applesauce-signers";
import { answerBenchmarkSigner } from "../helpers/benchmark-signer";
import type { BenchmarkWorkerInput, BenchmarkWorkerOutput } from "../helpers/benchmark-signer";
import type { BenchmarkReport, BenchmarkTarget, BenchmarkVerification } from "./concord-benchmark-runtime";

export type { BenchmarkReport, BenchmarkTarget, BenchmarkVerification } from "./concord-benchmark-runtime";

/** Each run gets a fresh module realm, including its crypto hooks and memo caches. */
export function startConcordBenchmark(
  signer: ISigner,
  target: BenchmarkTarget,
  timeoutMs: number,
  onUpdate: (report: BenchmarkReport) => void,
  verification: BenchmarkVerification = "wasm",
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error("Choose a timeout between 1 and 900 seconds.");
  }
  const worker = new Worker(new URL("./concord-benchmark.worker.ts", import.meta.url), { type: "module" });
  const beginning = performance.now();
  let report: BenchmarkReport = {
    status: "running", source: target.kind, verification, startedAt: new Date().toISOString(),
    elapsedMs: 0, receivedEvents: 0, uniqueEvents: 0, receivedEventBytes: 0, maxEventLoopLagMs: 0,
    diagnostics: {}, communities: [],
  };
  let done = false;
  const finish = (next: BenchmarkReport) => {
    if (done) return;
    done = true;
    clearTimeout(watchdog);
    worker.terminate();
    report = next;
    onUpdate(next);
  };
  const watchdog = setTimeout(() => finish({
    ...report, status: "timeout", elapsedMs: performance.now() - beginning,
    error: "The benchmark worker exceeded its setup or execution deadline.",
  }), timeoutMs + 30_000);
  const send = (message: BenchmarkWorkerInput) => { if (!done) worker.postMessage(message); };
  worker.onmessage = ({ data }: MessageEvent<BenchmarkWorkerOutput>) => {
    if (done) return;
    if (data.type === "signer") {
      void answerBenchmarkSigner(signer, data).then(send);
    } else if (data.type === "setup-error") {
      finish({ ...report, status: "error", error: "Could not initialize the selected crypto backend. No fallback was used." });
    } else if (data.report.status !== "running") finish(data.report);
    else { report = data.report; onUpdate(report); }
  };
  worker.onerror = (event) => {
    event.preventDefault();
    finish({ ...report, status: "error", error: "The isolated benchmark worker failed." });
  };
  try {
    send({
      type: "start", target, verification, timeoutMs,
      lookupRelays: import.meta.env.VITE_LOOKUP_RELAYS?.split(",").map((relay: string) => relay.trim()).filter(Boolean)
        ?? ["wss://purplepag.es", "wss://index.hzrd149.com"],
      nip04: !!signer.nip04, nip44: !!signer.nip44,
    });
    onUpdate(report);
  } catch {
    finish({ ...report, status: "error", error: "Could not start the isolated benchmark worker." });
  }
  return { cancel: () => finish({
    ...report, status: "cancelled",
    // A report's clock excludes backend setup; preserve that convention after setup.
    elapsedMs: report.preparationMs === undefined ? 0 : report.elapsedMs,
  }) };
}
