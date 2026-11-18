import type { ISigner } from "applesauce-signers";
import type { EventTemplate, NostrEvent } from "applesauce-core/helpers";
import type { BenchmarkReport, BenchmarkTarget, BenchmarkVerification } from "../services/concord-benchmark-runtime";

type SignerOperation =
  | { method: "getPublicKey" }
  | { method: "signEvent"; event: EventTemplate }
  | { method: "nip44.encrypt" | "nip44.decrypt" | "nip04.encrypt" | "nip04.decrypt"; pubkey: string; content: string };
export type BenchmarkSignerRequest = SignerOperation & { type: "signer"; id: number };
export type BenchmarkSignerResponse =
  | { type: "signer-result"; id: number; value: string | NostrEvent }
  | { type: "signer-result"; id: number; error: true };
export type BenchmarkWorkerInput = BenchmarkSignerResponse | {
  type: "start"; target: BenchmarkTarget; verification: BenchmarkVerification; timeoutMs: number;
  lookupRelays: string[]; nip04: boolean; nip44: boolean;
};
export type BenchmarkWorkerOutput = BenchmarkSignerRequest |
  { type: "report"; report: BenchmarkReport } | { type: "setup-error" };

/** Deliberately narrow signer bridge: never transfers an account or private key. */
export async function answerBenchmarkSigner(signer: ISigner, request: BenchmarkSignerRequest): Promise<BenchmarkSignerResponse> {
  try {
    let value: string | NostrEvent;
    if (request.method === "getPublicKey") value = await signer.getPublicKey();
    else if (request.method === "signEvent") value = await signer.signEvent(request.event);
    else {
      const [protocol, method] = request.method.split(".") as ["nip04" | "nip44", "encrypt" | "decrypt"];
      const api = signer[protocol];
      if (!api) throw new Error("Signer encryption is unavailable.");
      value = await api[method](request.pubkey, request.content);
    }
    return { type: "signer-result", id: request.id, value };
  } catch {
    return { type: "signer-result", id: request.id, error: true };
  }
}

export function createBenchmarkSigner(
  send: (request: BenchmarkSignerRequest) => void,
  capabilities: { nip04: boolean; nip44: boolean },
) {
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: string | NostrEvent) => void; reject: (error: Error) => void }>();
  const call = (operation: SignerOperation) => new Promise<string | NostrEvent>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ ...operation, type: "signer", id });
  });
  const encryption = (protocol: "nip04" | "nip44") => ({
    encrypt: (pubkey: string, content: string) => call({ method: `${protocol}.encrypt`, pubkey, content }) as Promise<string>,
    decrypt: (pubkey: string, content: string) => call({ method: `${protocol}.decrypt`, pubkey, content }) as Promise<string>,
  });
  const signer: ISigner = {
    getPublicKey: () => call({ method: "getPublicKey" }) as Promise<string>,
    signEvent: (event) => call({ method: "signEvent", event }) as Promise<NostrEvent>,
    nip04: capabilities.nip04 ? encryption("nip04") : undefined,
    nip44: capabilities.nip44 ? encryption("nip44") : undefined,
  };
  return {
    signer,
    receive(response: BenchmarkSignerResponse) {
      const request = pending.get(response.id);
      pending.delete(response.id);
      if (!request) return;
      if ("error" in response) request.reject(new Error("Benchmark signer request failed."));
      else request.resolve(response.value);
    },
  };
}
