// Empirically verify applesauce can send MULTIPLE NIP-42 AUTH messages on one
// connection, satisfying a strict (ditto-style) relay that requires every
// author in a kind-1059 REQ to be authenticated.
import { RelayPool } from "applesauce-relay";
import { WebSocket } from "ws";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import { firstValueFrom } from "rxjs";
import { filter, take, timeout } from "rxjs/operators";

// @ts-expect-error node global
globalThis.WebSocket = WebSocket;

const URL = "ws://localhost:7447";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Three "stream keys" (as Concord's control/guestbook/channel derived keys).
const streamKeys = [0, 1, 2].map(() => {
  const sk = generateSecretKey();
  return { sk, pk: getPublicKey(sk) };
});

const pool = new RelayPool();
const relay = pool.relay(URL);

// Log auth state transitions.
relay.authenticated$.subscribe((a) => console.log("  authenticated$ =", a));

// Publish one 1059 event authored by the first stream key so there is
// something to read back (writes are open on the mock).
const stored = finalizeEvent(
  { kind: 1059, content: "x", tags: [["p", getPublicKey(generateSecretKey())]], created_at: Math.floor(Date.now() / 1000) },
  streamKeys[0].sk,
);

async function main() {
  // Publishing opens the socket (writes are ungated on the mock) and stores an
  // event we can read back; the relay's AUTH challenge arrives on connect.
  await pool.publish([URL], stored);
  const challenge = await firstValueFrom(
    relay.challenge$.pipe(filter((c) => !!c), take(1), timeout(5000)),
  );
  console.log("got challenge:", challenge);

  // Sign a kind-22242 AUTH per stream key and send them all via relay.auth().
  const responses = [];
  for (const { sk, pk } of streamKeys) {
    const authEvent = finalizeEvent(
      { kind: 22242, content: "", tags: [["relay", URL], ["challenge", challenge]], created_at: Math.floor(Date.now() / 1000) },
      sk,
    );
    const res = await relay.auth(authEvent);
    console.log(`  auth ${pk.slice(0, 8)}… ->`, res.ok);
    responses.push(res);
  }
  const allOk = responses.every((r) => r.ok);
  console.log("all AUTH responses ok:", allOk);

  // REQ across ALL three stream-key authors (strict relay needs all authed).
  const events = [];
  const sub = pool
    .subscription([URL], [{ kinds: [1059], authors: streamKeys.map((k) => k.pk) }])
    .subscribe((e) => {
      if (typeof e !== "string") events.push(e);
    });
  await sleep(1500);
  sub.unsubscribe();

  console.log("events received over 3-author REQ:", events.length);
  const pass = allOk && events.length >= 1;
  console.log(pass ? "\n✅ applesauce sent MULTIPLE AUTH and a strict relay served the multi-author REQ" : "\n❌ multi-auth did not satisfy the strict relay");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
