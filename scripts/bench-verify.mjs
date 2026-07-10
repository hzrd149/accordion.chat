// Micro-benchmark: pure-JS (@noble) vs nostr-wasm Schnorr verification.
import { generateSecretKey, finalizeEvent, verifyEvent as pureVerify } from "nostr-tools/pure";
import { initNostrWasm } from "nostr-wasm";
import { setNostrWasm, verifyEvent as wasmVerify } from "nostr-tools/wasm";

const N = 2000;
const sk = generateSecretKey();
const events = [];
for (let i = 0; i < N; i++) {
  events.push(finalizeEvent({ kind: 1, content: "bench " + i, tags: [], created_at: 1700000000 + i }, sk));
}
// Rebuild plain events each run (only string keys) so neither verifier's cached
// `verifiedSymbol` short-circuits the work — a spread would copy that symbol.
const clone = () =>
  events.map((e) => ({
    id: e.id,
    pubkey: e.pubkey,
    created_at: e.created_at,
    kind: e.kind,
    tags: e.tags,
    content: e.content,
    sig: e.sig,
  }));

let t = performance.now();
for (const e of clone()) pureVerify(e);
const pureMs = performance.now() - t;

setNostrWasm(await initNostrWasm());
t = performance.now();
for (const e of clone()) wasmVerify(e);
const wasmMs = performance.now() - t;

console.log(`verify ${N} events:`);
console.log(`  pure JS (@noble):   ${pureMs.toFixed(1)} ms  (${((pureMs / N) * 1000).toFixed(1)} us/ev)`);
console.log(`  nostr-wasm (WASM):  ${wasmMs.toFixed(1)} ms  (${((wasmMs / N) * 1000).toFixed(1)} us/ev)`);
console.log(`  speedup: ${(pureMs / wasmMs).toFixed(1)}x`);
