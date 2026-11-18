import type { VerifiedEvent, VerifyEventMethod } from "applesauce-core/helpers";
import { verifyEvent as verifyJavaScript } from "nostr-tools/pure";
import { setNostrWasm } from "nostr-tools/wasm";
import { initNostrWasm } from "nostr-wasm";
import { verifyEventWasm } from "../crypto-wasm";
import type { BenchmarkVerification } from "../services/concord-benchmark-runtime";

/** Called only inside a fresh benchmark worker. WASM failure must not silently fall back. */
export async function createBenchmarkVerifier(mode: BenchmarkVerification): Promise<VerifyEventMethod> {
  switch (mode) {
    case "none": return (event): event is VerifiedEvent => Boolean(event);
    case "javascript": return verifyJavaScript;
    case "wasm":
      setNostrWasm(await initNostrWasm());
      return verifyEventWasm as VerifyEventMethod;
    default: throw new Error("Unknown benchmark verification mode.");
  }
}
