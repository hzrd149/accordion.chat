import { setVerifyWrappedEventMethod } from "applesauce-core/helpers";
import { createBenchmarkVerifier } from "../helpers/benchmark-verification";
import { createBenchmarkSigner } from "../helpers/benchmark-signer";
import type { BenchmarkWorkerInput, BenchmarkWorkerOutput } from "../helpers/benchmark-signer";
import { startConcordBenchmark } from "./concord-benchmark-runtime";

const send = (message: BenchmarkWorkerOutput) => self.postMessage(message);
let bridge: ReturnType<typeof createBenchmarkSigner> | undefined;
let started = false;
self.onmessage = async ({ data }: MessageEvent<BenchmarkWorkerInput>) => {
  if (data.type === "signer-result") { bridge?.receive(data); return; }
  if (started) return;
  started = true;
  const preparationStart = performance.now();
  try {
    const verifyEvent = await createBenchmarkVerifier(data.verification);
    // This module's global hook belongs ONLY to this worker's SDK instance.
    setVerifyWrappedEventMethod(verifyEvent);
    bridge = createBenchmarkSigner(send, data);
    const preparationMs = performance.now() - preparationStart;
    startConcordBenchmark(bridge.signer, data.target, data.timeoutMs,
      (report) => send({ type: "report", report: { ...report, preparationMs } }),
      { verification: data.verification, verifyEvent, lookupRelays: data.lookupRelays });
  } catch {
    send({ type: "setup-error" });
  }
};
