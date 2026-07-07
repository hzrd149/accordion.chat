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
import { finalizeEvent, generateSecretKey, getPublicKey, nip44 } from "nostr-tools";

// ── OURS (src/concord) ───────────────────────────────────────────────────────
import { createCommunity, deriveKeys, channelKeyFor } from "../src/concord/community";
import { createStreamEvent, decodeStreamEvent, rewrapSeal as ourRewrapSeal } from "../src/concord/stream";
import { messageRumor, checkChatBinding } from "../src/concord/chat";
import { foldControl } from "../src/concord/control";
import { foldMembers, buildSnapshotRumors as ourBuildSnapshotRumors } from "../src/concord/guestbook";
import { resolveStanding } from "../src/concord/permissions";
import { buildEdition, computeEditionHash, dissolutionRumor } from "../src/concord/editions";
import {
  dissolvedGroupKey as ourDissolvedGroupKey,
  baseRekeyGroupKey as ourBaseRekeyGroupKey,
  epochKeyCommitment as ourEpochKeyCommitment,
} from "../src/concord/crypto";
import {
  ROOT_SCOPE_HEX,
  buildRekeyRumors as ourBuildRekeyRumors,
  parseRekey as ourParseRekey,
  groupRotations as ourGroupRotations,
  checkContinuity as ourCheckContinuity,
  findBlob as ourFindBlob,
  encodeWrappedKey as ourEncodeWrappedKey,
  decodeWrappedKey as ourDecodeWrappedKey,
  bytesToBase64 as ourBytesToBase64,
  base64ToBytes as ourBase64ToBytes,
  rekeyLocator as ourRekeyLocator,
} from "../src/concord/rekey";
import { PERM, VSK } from "../src/concord/types";
import type { Role } from "../src/concord/types";
import { randomBytes } from "../src/lib/bytes";
import {
  isCommunityLive,
  addToList as ourAddToList,
  removeFromList as ourRemoveFromList,
  mergeCommunityLists as ourMergeLists,
  EMPTY_COMMUNITY_LIST as OUR_EMPTY_LIST,
} from "../src/concord/community-list";
import type { CommunityList as OurCommunityList } from "../src/concord/community-list";
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
  banlistLocator,
  bytesToHex,
  channelGroupKey as armChannelGroupKey,
  controlGroupKey as armControlGroupKey,
  dissolvedGroupKey as armDissolvedGroupKey,
  grantLocator,
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
import { foldControlState, isDissolved as armIsDissolved, sealDissolved as armSealDissolved } from "@/concord-v2/lib/control";
import {
  coalesceGuestbook,
  completeMemberlist,
  buildJoinRumor as armBuildJoinRumor,
  buildSnapshotRumors as armBuildSnapshotRumors,
  sealGuestbook as armSealGuestbook,
} from "@/concord-v2/lib/guestbook";
import {
  buildRekeyRumors as armBuildRekeyRumors,
  parseRekey as armParseRekey,
  groupRotations as armGroupRotations,
  checkContinuity as armCheckContinuity,
  findBlob as armFindBlob,
  encodeWrappedKey as armEncodeWrappedKey,
  decodeWrappedKey as armDecodeWrappedKey,
  bytesToBase64 as armBytesToBase64,
  base64ToBytes as armBase64ToBytes,
  myLocator as armMyLocator,
} from "@/concord-v2/lib/rekey";
import { baseRekeyGroupKey as armBaseRekeyGroupKey } from "@/concord-v2/lib/derive";
import {
  buildInviteUrl as armBuildInviteUrl,
  mintLinkSigner as armMintLinkSigner,
  parseBundleEvent as armParseBundleEvent,
  parseInviteLink as armParseInviteLink,
} from "@/concord-v2/lib/invite";
import {
  EMPTY_COMMUNITY_LIST,
  isLive as armIsLive,
  liveEntries as armLiveEntries,
  mergeCommunityLists,
  rehydrateCommunity,
  type CommunityList as ArmCommunityList,
} from "@/concord-v2/lib/communityList";

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

  // ═══ C2. Multi-edition fold: run the SAME edition set through BOTH folds ═══
  // The genesis fold (C) is one edition per entity — the easy case. This folds
  // a v1→v2 chained update through our fold AND armada's and compares, the
  // direct P3-drift probe (our owner-first fold vs armada's strict CORD-04).
  section("C2. multi-edition fold — our foldControl vs armada foldControlState");

  const metaV1 = JSON.stringify({ name: "Interop", description: "cross-client", relays: ["wss://x"] });
  const metaV2 = JSON.stringify({ name: "Interop v2", description: "renamed", relays: ["wss://x"] });
  const chV1 = JSON.stringify({ name: "general", private: false });
  const chV2 = JSON.stringify({ name: "lobby", private: false });
  const metaH1 = computeEditionHash({ vsk: VSK.METADATA, eid: material.community_id, version: 1, content: metaV1 });
  const chH1 = computeEditionHash({ vsk: VSK.CHANNEL, eid: chId, version: 1, content: chV1 });

  // Seal a batch of edition rumors on the control stream (plaintext seals).
  async function controlWraps(templates: ReturnType<typeof buildEdition>[]) {
    const out = [];
    for (const rumor of templates) {
      const { wrap } = await createStreamEvent({
        streamSk: ours.control.sk,
        convKey: ours.control.convKey,
        author: owner,
        rumor,
        plaintextSeal: true,
      });
      out.push(wrap);
    }
    return out;
  }
  const foldOurs = (wraps: Awaited<ReturnType<typeof controlWraps>>) =>
    foldControl(
      wraps.map((w) => decodeStreamEvent(w, ours.control.convKey)).filter((d): d is NonNullable<typeof d> => d !== null),
      material,
    );
  const foldArm = (wraps: Awaited<ReturnType<typeof controlWraps>>) =>
    foldControlState(wraps.map((w) => parseEdition(openWrap(w, armControl))), cid, ownerPub);

  // Happy path: a properly chained v1→v2 for both metadata and #general,
  // deliberately fed newest-first to prove order independence.
  const chained = await controlWraps([
    buildEdition({ vsk: VSK.CHANNEL, eid: chId, version: 2, prevHash: chH1, content: chV2 }),
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 2, prevHash: metaH1, content: metaV2 }),
    buildEdition({ vsk: VSK.CHANNEL, eid: chId, version: 1, content: chV1 }),
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 1, content: metaV1 }),
  ]);
  const ourChained = foldOurs(chained);
  const armChained = foldArm(chained);
  assert(ourChained.metadata?.name === "Interop v2", "our fold advances metadata to v2 (chained update)");
  assert(armChained.metadata?.name === "Interop v2", "armada fold advances metadata to v2");
  assert(ourChained.channels.find((c) => c.channel_id === chId)?.name === "lobby", "our fold renames channel to v2");
  assert(armChained.channels.get(chId)?.name === "lobby", "armada fold renames channel to v2");
  assert(
    ourChained.metadata?.name === armChained.metadata?.name,
    "both clients agree on folded metadata (order-independent)",
  );

  // Broken chain: a v2 whose `prev` cites nothing real. Both folds must refuse
  // the downgrade-gap and hold v1 (fail closed) — a forged higher-versioned
  // orphan must not suppress the legit head (CORD-04 §1). Regression guard for
  // the chain-contiguity enforcement in our foldControl.
  const broken = await controlWraps([
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 1, content: metaV1 }),
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 2, prevHash: "ff".repeat(32), content: metaV2 }),
  ]);
  const ourBroken = foldOurs(broken).metadata?.name;
  const armBroken = foldArm(broken).metadata?.name;
  console.log(`   broken-chain v2 → ours="${ourBroken}"  armada="${armBroken}"`);
  assert(ourBroken === "Interop", "our fold refuses a dangling-prev v2 and holds v1");
  assert(ourBroken === armBroken, "both folds agree on the broken-chain case (hold v1)");

  // Equal-version fork: a chained v1→v2 plus a competing forged v1. Both impls
  // resolve the v1 slot by the same tiebreak (lower rumor id), which in turn
  // decides whether v2's chain holds — so the required interop property is that
  // the two folds AGREE on the outcome, not any particular winner.
  const forked = await controlWraps([
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 1, content: metaV1 }),
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 2, prevHash: metaH1, content: metaV2 }),
    buildEdition({ vsk: VSK.METADATA, eid: material.community_id, version: 1, content: JSON.stringify({ name: "FORK", relays: [] }) }),
  ]);
  assert(
    foldOurs(forked).metadata?.name === foldArm(forked).metadata?.name,
    "our fold and armada agree on an equal-version fork (identical rumor-id tiebreak)",
  );

  // ═══ F. Guestbook plane cross-decode + fold (both directions) ═══
  section("F. guestbook plane (join) cross-decode + fold");
  // OUR Join → armada coalesces to a present member.
  const { wrap: ourJoinWrap } = await createStreamEvent({
    streamSk: ours.guestbook.sk,
    convKey: ours.guestbook.convKey,
    author: member,
    rumor: { kind: 3306, content: "join", tags: [["ms", "7"]] },
  });
  const armCoalesced = coalesceGuestbook([openWrap(ourJoinWrap, armGuest)], { nowMs: Date.now(), canKick: () => false });
  const armMembers = completeMemberlist(armCoalesced, new Map(), new Set());
  assert(armMembers.has(memberPub), "armada folds our guestbook Join to a present member");

  // ARMADA Join → our foldMembers reads it present.
  const armJoinWrap = await armSealGuestbook(armBuildJoinRumor(memberPub, Date.now()), armGuest, member);
  const ourGbDecoded = [decodeStreamEvent(armJoinWrap, ours.guestbook.convKey)].filter((d): d is NonNullable<typeof d> => d !== null);
  const noRoles = new Map<string, Role>();
  const ourMembers = foldMembers(ourGbDecoded, new Map(), new Set(), (m) => resolveStanding(m, ownerPub, noRoles, new Map()));
  assert(ourMembers.has(memberPub), "our fold reads armada's Join as a present member");

  // Snapshot (P2): a refounder-signed 3312 snapshot seeds present members. Our
  // snapshot seeds armada's coalesce (with snapshotAuthority = owner) and armada's
  // seeds our foldMembers.
  const ourSnapWraps = [];
  for (const rumor of ourBuildSnapshotRumors([memberPub, ownerPub], toHex(randomBytes(32)))) {
    ourSnapWraps.push((await createStreamEvent({ streamSk: ours.guestbook.sk, convKey: ours.guestbook.convKey, author: owner, rumor })).wrap);
  }
  const armSnapMembers = completeMemberlist(
    coalesceGuestbook(ourSnapWraps.map((w) => openWrap(w, armGuest)), { nowMs: Date.now(), canKick: () => false, snapshotAuthority: ownerPub }),
    new Map(),
    new Set(),
  );
  assert(armSnapMembers.has(memberPub) && armSnapMembers.has(ownerPub), "armada seeds present members from our guestbook snapshot");

  const armSnapWraps = [];
  for (const rumor of armBuildSnapshotRumors(ownerPub, [memberPub], toHex(randomBytes(32)), Date.now())) {
    armSnapWraps.push(await armSealGuestbook(rumor, armGuest, owner));
  }
  const ourSnapDecoded = armSnapWraps.map((w) => decodeStreamEvent(w, ours.guestbook.convKey)).filter((d): d is NonNullable<typeof d> => d !== null);
  const ourSnapMembers = foldMembers(ourSnapDecoded, new Map(), new Set(), (m) => resolveStanding(m, ownerPub, noRoles, new Map()));
  assert(ourSnapMembers.has(memberPub), "our foldMembers seeds a present member from armada's snapshot");

  // ═══ G. Roles / grants / banlist fold parity (CORD-04) ═══
  section("G. roles / grants / banlist fold parity");
  const roleId = toHex(randomBytes(32));
  const adminPerms =
    PERM.MANAGE_ROLES | PERM.MANAGE_CHANNELS | PERM.MANAGE_METADATA | PERM.KICK | PERM.BAN | PERM.MANAGE_MESSAGES | PERM.CREATE_INVITE;
  const roleJson = JSON.stringify({ role_id: roleId, name: "Admin", position: 1, permissions: adminPerms.toString(), scope: { kind: "server" }, color: 0 });
  const grantEid = bytesToHex(grantLocator(cid, hex32(memberPub)));
  const grantJson = JSON.stringify({ member: memberPub, role_ids: [roleId] });
  const outsider = getPublicKey(generateSecretKey());
  const banEid = bytesToHex(banlistLocator(cid));
  const rgbWraps = await controlWraps([
    buildEdition({ vsk: VSK.ROLE, eid: roleId, version: 1, content: roleJson }),
    buildEdition({ vsk: VSK.GRANT, eid: grantEid, version: 1, content: grantJson }),
    buildEdition({ vsk: VSK.BANLIST, eid: banEid, version: 1, content: JSON.stringify([outsider]) }),
  ]);
  const ourRGB = foldOurs(rgbWraps);
  const armRGB = foldArm(rgbWraps);
  assert(ourRGB.roles.find((r) => r.role_id === roleId)?.name === "Admin", "our fold accepts owner-minted Admin role");
  assert(armRGB.roster.roles.find((r) => r.roleId === roleId)?.name === "Admin", "armada fold accepts the same role");
  assert(ourRGB.grants.get(memberPub)?.includes(roleId), "our fold applies the grant to the member");
  assert(armRGB.roster.grants.find((g) => g.member === memberPub)?.roleIds.includes(roleId), "armada fold applies the same grant");
  assert(ourRGB.banlist.has(outsider), "our fold reads the banlist entry");
  assert(armRGB.banned.has(outsider), "armada fold reads the same banlist entry");

  // ═══ H. Private channel chat cross-decode ═══
  section("H. private channel chat cross-decode");
  const privKey = toHex(randomBytes(32));
  const privChId = toHex(randomBytes(32));
  const privMeta = { channel_id: privChId, name: "secret", private: true, key: privKey, epoch: 1 } as ChannelMetadata;
  const ourPriv = channelKeyFor(material, privMeta);
  const armPriv = armChannelGroupKey(hex32(privKey), hex32(privChId), 1);
  assert(ourPriv.pk === armPriv.pk, "private channel stream address matches (independent key)");
  const { wrap: privWrap } = await createStreamEvent({
    streamSk: ourPriv.sk,
    convKey: ourPriv.convKey,
    author: member,
    rumor: messageRumor(privChId, 1, "private hello"),
  });
  const privOpened = openWrap(privWrap, armPriv);
  checkChannelBinding(privOpened, privChId, 1n);
  assert(privOpened.content === "private hello", "armada reads our private-channel message");

  // ═══ I. Dissolution tombstone cross-detect ═══
  section("I. dissolution tombstone cross-detect");
  const ourDissKey = ourDissolvedGroupKey(hex32(material.community_id));
  const armDissKey = armDissolvedGroupKey(cid);
  assert(ourDissKey.pk === armDissKey.pk, "dissolved stream address matches");
  const { wrap: ourDissWrap } = await createStreamEvent({
    streamSk: ourDissKey.sk,
    convKey: ourDissKey.convKey,
    author: owner,
    rumor: dissolutionRumor(),
    plaintextSeal: true,
  });
  assert(armIsDissolved([ourDissWrap], cid, ownerPub), "armada detects our dissolution tombstone");
  const armDissWrap = await armSealDissolved(cid, ownerPub, owner);
  const ourDissDec = decodeStreamEvent(armDissWrap, ourDissKey.convKey);
  assert(
    ourDissDec?.author === ownerPub && ourDissDec.rumor.tags.some((t) => t[0] === "vsk" && t[1] === "10"),
    "our client detects armada's dissolution tombstone",
  );

  // ═══ J. CORD-06 rekey / refounding cross-client (the interop ceiling) ═══
  // A root rotation delivers the new community_root as per-recipient blobs at an
  // address derived from the PRIOR root. Prove a refounding by either client is
  // read, continuity-checked, and adopted by the other — and that an excluded
  // member is cryptographically severed (finds no blob).
  section("J. CORD-06 rekey / refounding cross-client");
  const rootBytes = hex32(material.community_root);
  const prevCommit = toHex(ourEpochKeyCommitment(0, rootBytes));
  assert(
    ourBaseRekeyGroupKey(rootBytes, cid, 1).pk === armBaseRekeyGroupKey(rootBytes, cid, 1n).pk,
    "base-rekey address for next epoch matches",
  );

  // Rotator + a kept member + an excluded member (fresh keys so we hold the sks).
  const rotSk = generateSecretKey();
  const rotator = new PrivateKeySigner(rotSk);
  const rotPub = await rotator.getPublicKey();
  const keptSk = generateSecretKey();
  const keptPub = getPublicKey(keptSk);
  const removedPub = getPublicKey(generateSecretKey());

  // --- OUR refounding → ARMADA (kept member) reads + adopts it ---
  const ourNewRoot = randomBytes(32);
  const ourAddr = ourBaseRekeyGroupKey(rootBytes, cid, 1);
  const ourPlain = ourBytesToBase64(ourEncodeWrappedKey(new Uint8Array(32), 1n, ourNewRoot));
  const ourBlob = {
    locator: ourRekeyLocator(rotPub, keptPub, ROOT_SCOPE_HEX, 1n),
    wrapped: nip44.encrypt(ourPlain, nip44.getConversationKey(rotSk, keptPub)),
  };
  const ourRekeyRumors = ourBuildRekeyRumors({ scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit }, [ourBlob]);
  const ourRekeyWraps = [];
  for (const rumor of ourRekeyRumors) {
    const { wrap } = await createStreamEvent({ streamSk: ourAddr.sk, convKey: ourAddr.convKey, author: rotator, rumor });
    ourRekeyWraps.push(wrap);
  }
  const armSets = armGroupRotations(ourRekeyWraps.map((w) => armParseRekey(openWrap(w, armBaseRekeyGroupKey(rootBytes, cid, 1n)))));
  assert(armSets.length === 1 && armSets[0].complete, "armada groups our rekey into one complete rotation");
  assert(armCheckContinuity(armSets[0], 0n, rootBytes).ok, "armada continuity-checks our rotation against the prior root");
  const armKeptBlob = armFindBlob(armSets[0], armMyLocator(rotPub, keptPub, ROOT_SCOPE_HEX, 1n));
  assert(armKeptBlob !== undefined, "armada (kept member) finds its blob");
  const armNewRoot = armDecodeWrappedKey(
    armBase64ToBytes(nip44.decrypt(armKeptBlob!.wrapped, nip44.getConversationKey(keptSk, rotPub))),
    new Uint8Array(32),
    1n,
  );
  assert(bytesToHex(armNewRoot) === toHex(ourNewRoot), "armada recovers the exact new root from our blob");
  assert(armFindBlob(armSets[0], armMyLocator(rotPub, removedPub, ROOT_SCOPE_HEX, 1n)) === undefined, "an excluded member finds no blob (severed)");

  // --- ARMADA refounding → OUR client reads + adopts it ---
  const armNewRoot2 = randomBytes(32);
  const armPlain2 = armBytesToBase64(armEncodeWrappedKey(new Uint8Array(32), 1n, armNewRoot2));
  const armBlob2 = {
    locator: armMyLocator(rotPub, keptPub, ROOT_SCOPE_HEX, 1n),
    wrapped: nip44.encrypt(armPlain2, nip44.getConversationKey(rotSk, keptPub)),
  };
  const armRekeyRumors = armBuildRekeyRumors(rotPub, { scope: { kind: "root" }, newEpoch: 1n, prevEpoch: 0n, prevCommit }, [armBlob2], Date.now());
  const armRekeyWraps = [];
  for (const rumor of armRekeyRumors) armRekeyWraps.push(armWrapSeal(await armSealRumor(rumor, KIND_SEAL_ENCRYPTED, ourAddr, rotator), ourAddr));
  const ourSets = ourGroupRotations(
    armRekeyWraps.map((w) => ourParseRekey(decodeStreamEvent(w, ourAddr.convKey)!)).filter((p): p is NonNullable<typeof p> => p !== null),
  );
  assert(ourSets.length === 1 && ourSets[0].complete, "our client groups armada's rekey into one complete rotation");
  assert(ourCheckContinuity(ourSets[0], 0n, rootBytes).ok, "our continuity check passes against the prior root");
  const ourKeptBlob = ourFindBlob(ourSets[0], ourRekeyLocator(rotPub, keptPub, ROOT_SCOPE_HEX, 1n));
  assert(ourKeptBlob !== undefined, "our client (kept member) finds its blob");
  const ourNewRoot2 = ourDecodeWrappedKey(
    ourBase64ToBytes(nip44.decrypt(ourKeptBlob!.wrapped, nip44.getConversationKey(keptSk, rotPub))),
    new Uint8Array(32),
    1n,
  );
  assert(toHex(ourNewRoot2) === toHex(armNewRoot2), "our client recovers the exact new root from armada's blob");

  // Continuity: a rotation whose prevcommit is over the WRONG root is rejected as a fork.
  assert(ourCheckContinuity(ourSets[0], 0n, randomBytes(32)).ok === false, "our continuity check rejects a wrong-prior-root (fork)");

  // Compaction (CORD-06 §3): a Refounding re-anchors the Control Plane by
  // re-wrapping each head's PLAINTEXT seal into the new epoch — no re-sign. Prove
  // our rewrapSeal produces a wrap armada opens + folds under the new root, with
  // the original owner still the verified author.
  const armNewControl = armControlGroupKey(ourNewRoot, cid, 1n);
  const genesisMetaWrap = (
    await createStreamEvent({
      streamSk: ours.control.sk,
      convKey: ours.control.convKey,
      author: owner,
      rumor: genesis.controlRumors[0], // the metadata edition (plaintext seal)
      plaintextSeal: true,
    })
  ).wrap;
  const decodedHead = decodeStreamEvent(genesisMetaWrap, ours.control.convKey);
  assert(decodedHead?.seal !== undefined, "our decode retains the plaintext seal for compaction");
  const compacted = ourRewrapSeal(decodedHead!.seal!, armNewControl.sk, armNewControl.convKey);
  const compactedEditions = [parseEdition(openWrap(compacted, armNewControl))];
  const compactedFold = foldControlState(compactedEditions, cid, ownerPub);
  assert(compactedFold.metadata?.name === "Interop", "armada folds our compacted (re-wrapped) metadata under the new root");
  assert(compactedFold.headEditions.size >= 1 && [...compactedFold.headEditions.values()][0].author === ownerPub, "compacted head keeps the original owner as verified author");

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

  // ═══ E. Community List (13302): document round-trip + liveness parity ═══
  section("E. community list (13302) — document round-trip + liveness parity");
  const cidStr = material.community_id;

  // The document our client writes (client.ts saveCommunityList): seed=current,
  // empty tombstones. Armada must ingest it, derive it live, and rehydrate.
  const ourDoc = {
    entries: [{ community_id: cidStr, seed: material, current: material, added_at: 100 }],
    tombstones: [] as unknown[],
  };
  const armMerged = mergeCommunityLists(EMPTY_COMMUNITY_LIST, ourDoc as unknown as ArmCommunityList);
  const armLive = armLiveEntries(armMerged);
  assert(armLive.length === 1 && armLive[0].community_id === cidStr, "armada ingests our list entry as live");
  const rehydrated = rehydrateCommunity(armLive[0]);
  assert(rehydrated?.idHex === cidStr, "armada rehydrates the community from our entry");
  assert(rehydrated?.owner === ownerPub, "rehydrated community keeps our owner");

  // Liveness parity across join / leave / re-join. Our isCommunityLive must
  // match armada's isLive — the resurrection rule (CORD-02 §8). Regression guard
  // for the loader that used to drop any id present in tombstones outright.
  const mk = (addedAt: number, removedAt?: number) => ({
    entries: [{ community_id: cidStr, seed: material, current: material, added_at: addedAt }],
    tombstones: removedAt === undefined ? [] : [{ community_id: cidStr, removed_at: removedAt }],
  });
  const cases: Array<{ label: string; doc: ReturnType<typeof mk>; live: boolean }> = [
    { label: "joined", doc: mk(100), live: true },
    { label: "left", doc: mk(100, 200), live: false },
    { label: "left then re-joined", doc: mk(300, 200), live: true },
  ];
  for (const c of cases) {
    const ours = isCommunityLive(c.doc as unknown as OurCommunityList, cidStr);
    const arm = armIsLive(c.doc as unknown as ArmCommunityList, cidStr);
    assert(ours === c.live, `our liveness for "${c.label}" is ${c.live}`);
    assert(ours === arm, `liveness agrees with armada for "${c.label}"`);
  }

  // Write-side merge: build a join→leave→rejoin document with OUR merge ops and
  // prove armada derives the same liveness (regression guard for the loader that
  // clobbered instead of merging, and never wrote tombstones on leave).
  let built = ourAddToList(OUR_EMPTY_LIST, { community_id: cidStr, seed: material, current: material, added_at: 100 });
  built = ourRemoveFromList(built, cidStr, 200); // leave
  built = ourAddToList(built, { community_id: cidStr, seed: material, current: material, added_at: 300 }); // re-join
  assert(isCommunityLive(built, cidStr), "our merge ops: join→leave→rejoin resolves live");
  const armIngest = armLiveEntries(mergeCommunityLists(EMPTY_COMMUNITY_LIST, built as unknown as ArmCommunityList));
  assert(armIngest.some((e) => e.community_id === cidStr), "armada agrees our rebuilt rejoin document is live");

  // Our merge and armada's merge agree on the same inputs (commutative + same rule).
  const partA = { entries: [{ community_id: cidStr, seed: material, current: material, added_at: 100 }], tombstones: [] };
  const partB = { entries: [] as unknown[], tombstones: [{ community_id: cidStr, removed_at: 50 }] };
  const ourM = ourMergeLists(partA as unknown as OurCommunityList, partB as unknown as OurCommunityList);
  const armM = mergeCommunityLists(partA as unknown as ArmCommunityList, partB as unknown as ArmCommunityList);
  assert(
    isCommunityLive(ourM, cidStr) === armIsLive(armM, cidStr),
    "our merge and armada merge agree on liveness (add beats older tombstone)",
  );

  void getPublicKey;
  void fromHex;
  console.log(`\n🎉 CROSS-CLIENT INTEROP VERIFIED — ${passed} assertions, both clients executed against each other.`);
}

main().catch((e) => {
  console.error("\n" + (e instanceof Error ? e.stack : String(e)));
  process.exit(1);
});
