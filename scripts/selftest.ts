// Standalone self-test of the Concord protocol core (run via esbuild + node).
import { finalizeEvent } from "nostr-tools";
import type { EventTemplate, NostrEvent } from "nostr-tools";
import { PrivateKeySigner } from "applesauce-signers";
import { createCommunity, deriveKeys, verifyOwner } from "../src/concord/community";
import { createStreamEvent, decodeStreamEvent } from "../src/concord/stream";
import { foldControl } from "../src/concord/control";
import { foldMembers } from "../src/concord/guestbook";
import { resolveStanding } from "../src/concord/permissions";
import { messageRumor } from "../src/concord/chat";
import { parseInviteLink, buildInviteLink, newInviteToken, encryptBundle, decryptBundle } from "../src/concord/invite";
import type { InviteBundle, DecodedEvent, Role } from "../src/concord/types";
import { getPublicKey, generateSecretKey } from "nostr-tools";
import { toHex } from "../src/lib/bytes";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
}

async function main() {
  // Owner signer
  const ownerSk = generateSecretKey();
  const owner = new PrivateKeySigner(ownerSk);
  const ownerPub = await owner.getPublicKey();

  // 1. Create community
  const genesis = createCommunity({ ownerPubkey: ownerPub, name: "Test", description: "hi", relays: ["wss://x"] });
  assert(verifyOwner(genesis.material), "owner proof verifies");

  const keys = deriveKeys(genesis.material, []);

  // 2. Publish genesis control editions (plaintext seal) — round-trip decode
  const controlDecoded: DecodedEvent[] = [];
  for (const rumor of genesis.controlRumors) {
    const { wrap } = await createStreamEvent({
      streamSk: keys.control.sk,
      convKey: keys.control.convKey,
      author: owner,
      rumor,
      plaintextSeal: true,
    });
    assert(wrap.kind === 1059, "control wrap is kind 1059");
    assert(wrap.pubkey === keys.control.pk, "control wrap addressed at control_pk");
    const dec = decodeStreamEvent(wrap, keys.control.convKey);
    assert(dec !== null, "control wrap decodes");
    assert(dec!.author === ownerPub, "control author is owner");
    assert(dec!.sealKind === 20014, "control uses plaintext seal");
    controlDecoded.push(dec!);
  }

  // 3. Fold control plane
  const state = foldControl(controlDecoded, genesis.material);
  assert(state.metadata?.name === "Test", "metadata folded");
  assert(state.channels.length === 1 && state.channels[0].name === "general", "general channel folded");

  // 4. Guestbook: owner join
  const gbDecoded: DecodedEvent[] = [];
  for (const rumor of genesis.guestbookRumors) {
    const { wrap } = await createStreamEvent({
      streamSk: keys.guestbook.sk,
      convKey: keys.guestbook.convKey,
      author: owner,
      rumor,
    });
    const dec = decodeStreamEvent(wrap, keys.guestbook.convKey);
    assert(dec!.sealKind === 20013, "guestbook uses encrypted seal");
    gbDecoded.push(dec!);
  }
  const rolesMap = new Map<string, Role>(state.roles.map((r) => [r.role_id, r]));
  const members = foldMembers(gbDecoded, new Map([[ownerPub, Date.now()]]), state.banlist, (m) =>
    resolveStanding(m, genesis.material.owner, rolesMap, state.grants),
  );
  assert(members.has(ownerPub), "owner is a member");

  // 5. Chat: send a message to #general, decode with a second member's key
  const chId = genesis.generalChannelId;
  const ownerKeys = deriveKeys(genesis.material, state.channels);
  const chKey = ownerKeys.channels.get(chId)!;
  const memberSk = generateSecretKey();
  const member = new PrivateKeySigner(memberSk);
  const memberPub = await member.getPublicKey();
  const { wrap: msgWrap, rumorId } = await createStreamEvent({
    streamSk: chKey.sk,
    convKey: chKey.convKey,
    author: member,
    rumor: messageRumor(chId, 0, "Hey chat!"),
  });
  // A different member re-derives the same channel key from the shared root:
  const memberKeys = deriveKeys(genesis.material, state.channels);
  const memberChKey = memberKeys.channels.get(chId)!;
  assert(memberChKey.pk === chKey.pk, "both members derive same channel address");
  const msgDec = decodeStreamEvent(msgWrap, memberChKey.convKey);
  assert(msgDec !== null, "message decodes for another member");
  assert(msgDec!.rumor.content === "Hey chat!", "message content intact");
  assert(msgDec!.author === memberPub, "message author correct");
  assert(msgDec!.rumor.id === rumorId, "rumor id stable");

  // 6. Invite link round-trip
  const token = newInviteToken();
  const linkSk = generateSecretKey();
  const linkPub = getPublicKey(linkSk);
  const bundle: InviteBundle = {
    community_id: genesis.material.community_id,
    owner: ownerPub,
    owner_salt: genesis.material.owner_salt,
    community_root: genesis.material.community_root,
    root_epoch: 0,
    channels: [],
    relays: ["wss://jskitty.com/nostr"],
    name: "Test",
    creator_npub: ownerPub,
  };
  const enc = encryptBundle(bundle, token);
  const back = decryptBundle(enc, token);
  assert(back.community_id === bundle.community_id, "bundle encrypts/decrypts");
  const link = buildInviteLink("https://app.example", linkPub, token, ["wss://jskitty.com/nostr"]);
  const parsed = parseInviteLink(link);
  assert(parsed.linkSigner === linkPub, "invite link signer round-trips");
  assert(toHex(parsed.token) === toHex(token), "invite token round-trips");

  // 7. Tamper detection: wrong conv key fails to decode
  const wrongKey = deriveKeys({ ...genesis.material, community_root: toHex(generateSecretKey()) }, []).control.convKey;
  assert(decodeStreamEvent(msgWrap, wrongKey) === null, "wrong key cannot decode (outsider sees noise)");

  void finalizeEvent as unknown as EventTemplate;
  void ({} as NostrEvent);
  console.log("\nALL SELFTESTS PASSED");
}

main().catch((e) => {
  console.error(e);
  throw e;
});
