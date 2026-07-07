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

  // 8. Stream-key NIP-42 auth: each registered key yields a signer that produces
  //    a verifiable kind-22242. Signing itself is native applesauce
  //    (`relay.authenticate`); here we exercise the registry's signers directly.
  const { registerStreamKeys, streamSigners, streamPubkeys, _resetStreamAuthRegistry } = await import(
    "../src/concord/stream-auth"
  );
  const { verifyEvent } = await import("nostr-tools");
  _resetStreamAuthRegistry();
  registerStreamKeys([keys.control, keys.guestbook]);
  const signers = streamSigners();
  assert(signers.length === 2, "one signer per registered stream key");
  assert(
    streamPubkeys().includes(keys.control.pk) && streamPubkeys().includes(keys.guestbook.pk),
    "registry holds each stream pubkey",
  );
  const auths = await Promise.all(
    signers.map(({ signer }) =>
      signer.signEvent({
        kind: 22242,
        content: "",
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ["relay", "wss://relay.example"],
          ["challenge", "challenge-abc"],
        ],
      }),
    ),
  );
  assert(
    auths.every((e) => e.kind === 22242 && verifyEvent(e)),
    "each stream signer produces a valid signed kind-22242",
  );
  assert(
    signers.some(({ pubkey }) => pubkey === keys.control.pk) &&
      signers.some(({ pubkey }) => pubkey === keys.guestbook.pk),
    "signers authenticate AS the stream pubkeys",
  );
  assert(
    auths.every((e) => e.tags.find((t) => t[0] === "challenge")?.[1] === "challenge-abc"),
    "stream AUTH events carry the relay challenge",
  );

  // 9. Voice (CORD-07): both members derive the same room, grants verify,
  //    presence round-trips through the ephemeral wrap, and rendezvous is stable.
  {
    const { voiceKeysFor } = await import("../src/concord/community");
    const {
      signAvGrant,
      parsePresence,
      presenceTags,
      foldVoicePresence,
      verifiedAuthorOf,
      canonicalOrigin,
      brokerRank,
      orderBrokers,
      rendezvousCandidates,
    } = await import("../src/concord/voice");
    const voiceCh = { ...state.channels[0], voice: true };
    const ownerVoice = voiceKeysFor(genesis.material, voiceCh);
    const memberVoice = voiceKeysFor(genesis.material, voiceCh);
    assert(ownerVoice.room.pk === memberVoice.room.pk, "both members derive same voice room");
    assert(toHex(ownerVoice.mediaKey) === toHex(memberVoice.mediaKey), "both members derive same media key");
    assert(ownerVoice.room.pk !== chKey.pk, "voice room differs from chat address");

    // Token grant: kind-27235 self-signed by voice_key.sk, pubkey == room.
    const grantUrl = `https://broker.example/.well-known/concord/av/${ownerVoice.room.pk}`;
    const grant = JSON.parse(atob(signAvGrant(ownerVoice.room, grantUrl))) as NostrEvent;
    assert(grant.kind === 27235 && verifyEvent(grant), "voice grant is a valid kind-27235");
    assert(grant.pubkey === ownerVoice.room.pk, "grant pubkey equals the room name");
    assert(grant.tags.find((t) => t[0] === "u")?.[1] === grantUrl, "grant binds the exact url");

    // Presence round-trip: a `joined` rumor over the channel's ephemeral wrap.
    const identity = "a".repeat(32);
    const presRumor = {
      kind: 23313,
      content: "joined",
      tags: [
        ["channel", voiceCh.channel_id],
        ["epoch", "0"],
        ...presenceTags("joined", identity, "https://broker.example"),
        ["ms", "417"],
      ],
    };
    const { wrap: presWrap } = await createStreamEvent({
      streamSk: chKey.sk,
      convKey: chKey.convKey,
      author: member,
      rumor: presRumor,
      ephemeral: true,
    });
    assert(presWrap.kind === 21059, "presence uses the ephemeral wrap");
    const presDec = decodeStreamEvent(presWrap, chKey.convKey);
    assert(presDec !== null, "presence decodes at the channel address");
    const entry = parsePresence(presDec!);
    assert(entry !== null && entry.status === "joined", "presence parses as joined");
    assert(entry!.identity === identity, "presence carries the SFU identity");
    assert(entry!.broker === "https://broker.example", "presence carries the canonicalized broker");
    const fold = foldVoicePresence([entry!], presDec!.ms);
    assert(fold.present.length === 1 && fold.present[0].author === memberPub, "fold shows the member present");
    assert(verifiedAuthorOf(fold, identity) === memberPub, "sole claimant of an identity verifies");

    // A contested identity (two authors claiming it) verifies for neither.
    const contested = foldVoicePresence(
      [
        { author: memberPub, status: "joined", identity, broker: "https://b.example", ms: 1, rumorId: "x" },
        { author: ownerPub, status: "joined", identity, broker: "https://b.example", ms: 2, rumorId: "y" },
      ],
      2,
    );
    assert(verifiedAuthorOf(contested, identity) === undefined, "contested identity verifies for no one");

    // Stale presence ages out.
    const stale = foldVoicePresence([entry!], presDec!.ms + 91_000);
    assert(stale.present.length === 0, "presence older than 90s counts as absent");

    // Rendezvous tie-break is canonical and stable.
    assert(canonicalOrigin("https://Broker.Example:443/path/") === "https://broker.example", "origin canonicalizes");
    assert(canonicalOrigin("http://broker.example") === null, "plaintext http origin refused");
    const room = ownerVoice.room.pk;
    const ordered = orderBrokers(room, ["https://b.example", "https://a.example"]);
    assert(
      ordered[0] === (brokerRank(room, "https://a.example") < brokerRank(room, "https://b.example") ? "https://a.example" : "https://b.example"),
      "brokers order by the sha256 tie-break",
    );
    const rendezvous = rendezvousCandidates(room, fold, ["https://my.example"]);
    assert(rendezvous[0] === "https://broker.example", "rendezvous joins the occupied broker first");
    assert(rendezvous.includes("https://my.example"), "own default is the fallback candidate");
  }

  void finalizeEvent as unknown as EventTemplate;
  void ({} as NostrEvent);
  console.log("\nALL SELFTESTS PASSED");
}

main().catch((e) => {
  console.error(e);
  throw e;
});
