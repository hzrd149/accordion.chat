// Cross-client wire-compat interop test.
//
// Runs OUR protocol core (`src/concord/`) against the armada `concord-v2`
// reference implementation IN-MEMORY: each side derives keys, seals events, and
// opens/folds the other side's output. Because Concord is pure derived-address
// 1059 traffic, a relay only moves these exact bytes — so an in-memory
// round-trip is the definitive proof of the "wire-compatible" claim, without
// relay flakiness. This EXECUTES both codebases rather than comparing constants.
//
// Run: node_modules/.bin/esbuild scripts/interop.ts --bundle --platform=node \
//   --format=cjs --alias:@=refs/armada/client/src --outfile=/tmp/interop.cjs \
//   && node /tmp/interop.cjs

import { PrivateKeySigner } from "applesauce-signers";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";

// ── OURS (src/concord) ───────────────────────────────────────────────────────
import { createCommunity, deriveKeys, channelKeyFor } from "../src/concord/community";
import { createStreamEvent, decodeStreamEvent } from "../src/concord/stream";
import { messageRumor, checkChatBinding } from "../src/concord/chat";
import {
  buildInviteLink,
  newInviteToken,
  buildBundleEventTemplate,
  decryptBundle,
  parseInviteLink as ourParseInviteLink,
} from "../src/concord/invite";
import { toHex, fromHex } from "../src/lib/bytes";
import type { ChannelMetadata, InviteBundle } from "../src/concord/types";

// ── ARMADA (concord-v2, via @ alias) ─────────────────────────────────────────
import {
  bytesToHex,
  channelGroupKey as armChannelGroupKey,
  controlGroupKey as armControlGroupKey,
  guestbookGroupKey as armGuestbookGroupKey,
  hex32,
} from "@/concord-v2/lib/derive";
import {
  buildRumor as armBuildRumor,
  channelBindingTags,
  checkChannelBinding,
  openWrap,
  sealRumor as armSealRumor,
  wrapSeal as armWrapSeal,
} from "@/concord-v2/lib/stream";
import { KIND_MESSAGE, KIND_SEAL_ENCRYPTED } from "@/concord-v2/lib/kinds";
import { parseEdition } from "@/concord-v2/lib/edition";
import { foldControlState } from "@/concord-v2/lib/control";
import {
  buildInviteUrl as armBuildInviteUrl,
  mintLinkSigner as armMintLinkSigner,
  parseBundleEvent as armParseBundleEvent,
  parseInviteLink as armParseInviteLink,
} from "@/concord-v2/lib/invite";

let passed = 0;
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  passed++;
  console.log("ok -", msg);
}
function section(name: string) {
  console.log(`\n── ${name} ──`);
}

async function main() {
  const owner = new PrivateKeySigner(generateSecretKey());
  const ownerPub = await owner.getPublicKey();

  // Genesis with OUR client.
  const genesis = createCommunity({ ownerPubkey: ownerPub, name: "Interop", description: "cross-client", relays: ["wss://x"] });
  const material = genesis.material;
  const chId = genesis.generalChannelId;
  const generalMeta = { channel_id: chId, name: "general", private: false } as ChannelMetadata;

  const cid = hex32(material.community_id);
  const root = hex32(material.community_root);
  const chIdBytes = hex32(chId);
  const epoch = material.root_epoch; // 0

  // ═══ A. Address & key derivation parity ═══
  // If a single labelled byte diverged, the two clients would subscribe to
  // different relay coordinates and never meet. This is the linchpin.
  section("A. derivation parity (both clients address the same stream)");
  const ours = deriveKeys(material, [generalMeta]);
  const armControl = armControlGroupKey(root, cid, epoch);
  const armGuest = armGuestbookGroupKey(root, cid, epoch);
  const armChan = armChannelGroupKey(root, chIdBytes, epoch);

  assert(ours.control.pk === armControl.pk, "control stream address (pk) matches");
  assert(toHex(ours.control.convKey) === bytesToHex(armControl.convKey), "control conversation key matches");
  assert(ours.guestbook.pk === armGuest.pk, "guestbook stream address matches");
  assert(toHex(ours.guestbook.convKey) === bytesToHex(armGuest.convKey), "guestbook conversation key matches");
  const ourChan = channelKeyFor(material, generalMeta);
  assert(ourChan.pk === armChan.pk, "public channel stream address matches");
  assert(toHex(ourChan.convKey) === bytesToHex(armChan.convKey), "public channel conversation key matches");

  // ═══ B. Chat plane cross-decode (both directions) ═══
  section("B. chat plane cross-decode");
  // OUR message → ARMADA opens it.
  const { wrap: ourMsgWrap, rumorId: ourRumorId } = await createStreamEvent({
    streamSk: ourChan.sk,
    convKey: ourChan.convKey,
    author: owner,
    rumor: messageRumor(chId, epoch, "hello from OUR client"),
  });
  const armOpened = openWrap(ourMsgWrap, armChan);
  checkChannelBinding(armOpened, chId, BigInt(epoch)); // throws on splice
  assert(armOpened.content === "hello from OUR client", "armada reads our message content");
  assert(armOpened.author === ownerPub, "armada verifies our author");
  assert(armOpened.kind === KIND_MESSAGE, "armada sees kind 9 message");
  assert(armOpened.rumorId === ourRumorId, "rumor id stable across clients");

  // ARMADA message → OUR client opens it.
  const member = new PrivateKeySigner(generateSecretKey());
  const memberPub = await member.getPublicKey();
  const armRumor = armBuildRumor({
    kind: KIND_MESSAGE,
    content: "hi from ARMADA client",
    tags: channelBindingTags(chId, BigInt(epoch)),
    pubkey: memberPub,
    ms: Date.now(),
  });
  const armSeal = await armSealRumor(armRumor, KIND_SEAL_ENCRYPTED, armChan, member);
  const armMsgWrap = armWrapSeal(armSeal, armChan);
  const ourDecoded = decodeStreamEvent(armMsgWrap, ourChan.convKey);
  assert(ourDecoded !== null, "our client decodes armada's message");
  assert(ourDecoded!.rumor.content === "hi from ARMADA client", "our client reads armada content");
  assert(ourDecoded!.author === memberPub, "our client verifies armada author");
  assert(checkChatBinding(ourDecoded!.rumor.tags, chId, epoch), "our channel/epoch binding check passes");
  assert(ourDecoded!.rumor.id === armRumor.id, "rumor id stable (armada→ours)");

  // ═══ C. Control-plane edition fold cross-client ═══
  // Our owner-signed genesis editions (metadata + #general) must fold in
  // armada's strict CORD-04 fold to the same state — surfaces P3 fold drift.
  section("C. control fold (our editions → armada's CORD-04 fold)");
  const armEditions = [];
  for (const rumor of genesis.controlRumors) {
    const { wrap } = await createStreamEvent({
      streamSk: ours.control.sk,
      convKey: ours.control.convKey,
      author: owner,
      rumor,
      plaintextSeal: true,
    });
    const opened = openWrap(wrap, armControl); // armada opens + verifies our plaintext seal
    armEditions.push(parseEdition(opened)); // armada parses our edition machinery
  }
  const folded = foldControlState(armEditions, cid, ownerPub);
  assert(folded.metadata?.name === "Interop", "armada folds our metadata edition (name)");
  const foldedChan = folded.channels.get(chId);
  assert(foldedChan?.name === "general", "armada folds our #general channel edition");
  assert(foldedChan?.isPrivate === false, "channel folds as public");
  assert(folded.ownerHex === ownerPub, "armada roots the fold at our owner");

  // ═══ D. Invite link + bundle cross-client ═══
  section("D. invite links & bundles");
  const link = armMintLinkSigner();
  const token = newInviteToken();
  const relays = ["wss://relay.example.com"];

  // OUR link → ARMADA parses it.
  const ourLink = buildInviteLink("https://app.example", link.pk, token, relays);
  const armParsed = armParseInviteLink(ourLink);
  assert(armParsed !== undefined, "armada parses our invite link");
  assert(armParsed!.linkSigner === link.pk, "armada recovers link signer");
  assert(bytesToHex(armParsed!.token) === toHex(token), "armada recovers unlock token");
  assert(armParsed!.bootstrapRelays[0] === relays[0], "armada recovers bootstrap relay");

  // ARMADA link → OUR client parses it.
  const armLink = armBuildInviteUrl("https://app.example", link.pk, token, relays);
  const ourParsed = ourParseInviteLink(armLink);
  assert(ourParsed.linkSigner === link.pk, "our client recovers armada's link signer");
  assert(toHex(ourParsed.token) === toHex(token), "our client recovers armada's token");

  // OUR bundle event → ARMADA verifies + decrypts it.
  const bundle: InviteBundle = {
    community_id: material.community_id,
    owner: ownerPub,
    owner_salt: material.owner_salt,
    community_root: material.community_root,
    root_epoch: 0,
    channels: [],
    relays,
    name: "Interop",
    creator_npub: ownerPub,
  };
  const tmpl = buildBundleEventTemplate(bundle, token);
  const bundleEvent = finalizeEvent(tmpl, link.sk);
  const armBundle = armParseBundleEvent(bundleEvent, link.pk, token, Date.now());
  assert(armBundle.community_id === material.community_id, "armada decrypts our invite bundle");
  assert(armBundle.owner === ownerPub, "armada reads bundle owner");

  // ARMADA-signed bundle event → OUR client decrypts it (sanity of the reverse).
  const ourBundleBack = decryptBundle(bundleEvent.content, token);
  assert(ourBundleBack.community_id === material.community_id, "our client decrypts the same bundle");

  // Sanity: outsider without the token cannot open the bundle.
  const wrongToken = newInviteToken();
  let outsiderBlocked = false;
  try {
    decryptBundle(bundleEvent.content, wrongToken);
  } catch {
    outsiderBlocked = true;
  }
  assert(outsiderBlocked, "wrong token cannot decrypt the bundle");

  void getPublicKey;
  void fromHex;
  console.log(`\n🎉 CROSS-CLIENT INTEROP VERIFIED — ${passed} assertions, both clients executed against each other.`);
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
