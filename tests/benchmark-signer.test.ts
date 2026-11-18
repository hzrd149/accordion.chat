import { describe, expect, it, vi } from "vitest";
import type { ISigner } from "applesauce-signers";
import { answerBenchmarkSigner, createBenchmarkSigner } from "../src/helpers/benchmark-signer";
import type { BenchmarkSignerRequest } from "../src/helpers/benchmark-signer";

describe("benchmark signer bridge", () => {
  it("proxies signer methods without transferring the signer or key material", async () => {
    const account: ISigner = {
      getPublicKey: vi.fn(async () => "public-key"),
      signEvent: vi.fn(),
      nip44: { decrypt: vi.fn(async () => "plaintext"), encrypt: vi.fn(async () => "ciphertext") },
    };
    const requests: BenchmarkSignerRequest[] = [];
    const bridge = createBenchmarkSigner((request) => { requests.push(request); }, { nip04: false, nip44: true });
    const key = bridge.signer.getPublicKey();
    bridge.receive(await answerBenchmarkSigner(account, requests.shift()!));
    expect(await key).toBe("public-key");
    const plaintext = bridge.signer.nip44!.decrypt("peer", "ciphertext");
    const request = requests.shift()!;
    expect(request).toMatchObject({ method: "nip44.decrypt", pubkey: "peer", content: "ciphertext" });
    bridge.receive(await answerBenchmarkSigner(account, request));
    expect(await plaintext).toBe("plaintext");
    expect(account.nip44!.decrypt).toHaveBeenCalledWith("peer", "ciphertext");
    expect(bridge.signer.nip04).toBeUndefined();
  });

  it("does not leak signer exception contents across the worker boundary", async () => {
    const account = {
      getPublicKey: vi.fn(async () => { throw new Error("secret-bearing error"); }),
      signEvent: vi.fn(),
    };
    const send = vi.fn();
    const bridge = createBenchmarkSigner(send, { nip04: false, nip44: false });
    const result = bridge.signer.getPublicKey();
    const rejected = expect(result).rejects.toThrow("Benchmark signer request failed.");
    const response = await answerBenchmarkSigner(account, send.mock.lastCall![0]);
    expect(response).toEqual({ type: "signer-result", id: 0, error: true });
    bridge.receive(response);
    await rejected;
  });
});
