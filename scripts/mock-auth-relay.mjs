// A minimal Nostr relay that REQUIRES NIP-42 AUTH before serving reads (REQ).
// Used to prove the client auto-authenticates. Writes (EVENT) are accepted
// without auth so events get stored; reads are gated.
import { WebSocketServer } from "ws";
import { verifyEvent } from "nostr-tools";

const PORT = Number(process.env.PORT || 7447);
const store = []; // all stored events

function matches(filter, ev) {
  if (filter.ids && !filter.ids.includes(ev.id)) return false;
  if (filter.kinds && !filter.kinds.includes(ev.kind)) return false;
  if (filter.authors && !filter.authors.includes(ev.pubkey)) return false;
  for (const k of Object.keys(filter)) {
    if (k[0] === "#") {
      const tagName = k.slice(1);
      const want = filter[k];
      const have = ev.tags.filter((t) => t[0] === tagName).map((t) => t[1]);
      if (!want.some((w) => have.includes(w))) return false;
    }
  }
  return true;
}

// STRICT=1 → ditto-style: EVERY author in a kind-1059 REQ must be an
// authenticated pubkey on the connection (a single user auth is not enough).
const STRICT = process.env.STRICT === "1";
const wss = new WebSocketServer({ port: PORT });
let challengeCounter = 0;
wss.on("connection", (ws) => {
  const challenge = "chal-" + ++challengeCounter + "-" + Date.now();
  const authedSet = new Set(); // pubkeys authenticated on THIS connection
  console.log(`[relay] connection #${challengeCounter}${STRICT ? " (strict)" : ""}`);
  ws.send(JSON.stringify(["AUTH", challenge]));

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const [type] = msg;
    if (type === "EVENT") {
      const ev = msg[1];
      if (ev.kind === 22242) return; // stray auth as EVENT — ignore
      store.push(ev);
      ws.send(JSON.stringify(["OK", ev.id, true, ""]));
    } else if (type === "AUTH") {
      const ev = msg[1];
      const okSig = verifyEvent(ev);
      const chal = ev.tags.find((t) => t[0] === "challenge")?.[1];
      if (okSig && ev.kind === 22242 && chal === challenge) {
        authedSet.add(ev.pubkey);
        ws.send(JSON.stringify(["OK", ev.id, true, ""]));
        console.log(`[relay] authenticated ${ev.pubkey.slice(0, 8)}… (now ${authedSet.size} on conn)`);
      } else {
        ws.send(JSON.stringify(["OK", ev?.id, false, "auth-required: bad auth"]));
      }
    } else if (type === "REQ") {
      const subId = msg[1];
      const filters = msg.slice(2);
      // ditto's AUTH_KINDS gates only kind-1059 traffic: a REQ that queries 1059
      // must have every one of THOSE filters' authors authenticated. Other kinds
      // (33301 invite bundle, 13302 list) are served without auth.
      const gatedKinds = [1059, 21059];
      const neededAuthors = STRICT
        ? filters.filter((f) => (f.kinds ?? []).some((k) => gatedKinds.includes(k))).flatMap((f) => f.authors ?? [])
        : [];
      const missing = STRICT
        ? neededAuthors.filter((a) => !authedSet.has(a))
        : authedSet.size === 0
          ? ["<any>"]
          : [];
      if (missing.length > 0) {
        console.log(`[relay] REQ ${subId} rejected — unauthed authors: ${missing.map((m) => m.slice(0, 8)).join(",")}`);
        ws.send(JSON.stringify(["CLOSED", subId, "auth-required: authenticate as the queried authors"]));
        return;
      }
      console.log(`[relay] REQ ${subId} served (${authedSet.size} authed on conn)`);
      for (const ev of store) {
        if (filters.some((f) => matches(f, ev))) ws.send(JSON.stringify(["EVENT", subId, ev]));
      }
      ws.send(JSON.stringify(["EOSE", subId]));
    } else if (type === "CLOSE") {
      /* no-op */
    }
  });
});
console.log(`[relay] mock auth-required relay listening on ws://localhost:${PORT}`);
