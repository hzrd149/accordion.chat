import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startConcordBenchmark } from "../src/services/concord-benchmark";
import type { BenchmarkReport } from "../src/services/concord-benchmark";

class FakeWorker {
  static instances: FakeWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage?: (event: { data: unknown }) => void;
  onerror?: (event: { preventDefault: () => void }) => void;
  constructor() { FakeWorker.instances.push(this); }
  receive(data: unknown) { this.onmessage?.({ data }); }
}

const signer = { getPublicKey: vi.fn(async () => "public-key"), signEvent: vi.fn() };
beforeEach(() => {
  FakeWorker.instances = [];
  vi.stubGlobal("Worker", FakeWorker);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it.each(["wasm", "javascript", "none"] as const)("starts a new isolated worker with %s, not the application's verifier", (mode) => {
  const update = vi.fn();
  const run = startConcordBenchmark(signer, { kind: "list" }, 5_000, update, mode);
  const worker = FakeWorker.instances[0];
  expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
    type: "start", verification: mode, target: { kind: "list" },
  }));
  expect(update.mock.lastCall?.[0].verification).toBe(mode);
  const report = { ...update.mock.lastCall![0], status: "complete" } as BenchmarkReport;
  worker.receive({ type: "report", report });
  expect(update.mock.lastCall?.[0]).toEqual(report);
  expect(worker.terminate).toHaveBeenCalledOnce();
  run.cancel();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("terminates on cancellation and ignores late signer responses and worker updates", async () => {
  let resolve!: (value: string) => void;
  const update = vi.fn();
  const run = startConcordBenchmark({
    ...signer, getPublicKey: () => new Promise<string>((done) => { resolve = done; }),
  }, { kind: "list" }, 5_000, update, "none");
  const worker = FakeWorker.instances[0];
  worker.receive({ type: "signer", id: 1, method: "getPublicKey" });
  run.cancel();
  resolve("public-key");
  await vi.advanceTimersByTimeAsync(0);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(update.mock.lastCall?.[0].status).toBe("cancelled");
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("reports crypto initialization failures without changing the requested backend", () => {
  const update = vi.fn();
  startConcordBenchmark(signer, { kind: "list" }, 5_000, update, "wasm");
  const worker = FakeWorker.instances[0];
  worker.receive({ type: "setup-error" });
  expect(update.mock.lastCall?.[0]).toMatchObject({ status: "error", verification: "wasm" });
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("has a bounded deadline even when worker initialization hangs", async () => {
  const update = vi.fn();
  startConcordBenchmark(signer, { kind: "list" }, 5_000, update, "wasm");
  await vi.advanceTimersByTimeAsync(35_000);
  expect(update.mock.lastCall?.[0].status).toBe("timeout");
  expect(FakeWorker.instances[0].terminate).toHaveBeenCalledOnce();
});
