// High-level community model: key derivation, owner verification, genesis.

import { fromHex, randomBytes, toHex } from "../lib/bytes";
import {
  channelGroupKey,
  communityId,
  controlGroupKey,
  guestbookGroupKey,
} from "./crypto";
import type { GroupKey } from "./crypto";
import { buildEdition } from "./editions";
import type { RumorTemplate } from "./stream";
import { VSK } from "./types";
import type {
  ChannelMetadata,
  CommunityMetadata,
  JoinMaterial,
} from "./types";

/** The set of stream keys a member holds for a community at its current epoch. */
export interface CommunityKeys {
  control: GroupKey;
  guestbook: GroupKey;
  /** channel_id -> group key (public derived from root; private from its key) */
  channels: Map<string, GroupKey>;
}

export function channelKeyFor(material: JoinMaterial, channel: ChannelMetadata): GroupKey {
  if (channel.private && channel.key) {
    return channelGroupKey(fromHex(channel.key), fromHex(channel.channel_id), channel.epoch ?? 1);
  }
  // Public channel: key derives from community_root at the root epoch.
  return channelGroupKey(fromHex(material.community_root), fromHex(channel.channel_id), material.root_epoch);
}

export function deriveKeys(material: JoinMaterial, channels: ChannelMetadata[]): CommunityKeys {
  const cid = fromHex(material.community_id);
  const root = fromHex(material.community_root);
  const channelKeys = new Map<string, GroupKey>();
  for (const ch of channels) channelKeys.set(ch.channel_id, channelKeyFor(material, ch));
  return {
    control: controlGroupKey(root, cid, material.root_epoch),
    guestbook: guestbookGroupKey(root, cid, material.root_epoch),
    channels: channelKeys,
  };
}

/** Verify a community's owner proof: community_id == sha256(owner || salt). */
export function verifyOwner(material: JoinMaterial): boolean {
  const expected = toHex(communityId(material.owner, fromHex(material.owner_salt)));
  return expected === material.community_id;
}

export interface Genesis {
  material: JoinMaterial;
  generalChannelId: string;
  /** control-plane editions to publish (plaintext seal at control_pk) */
  controlRumors: RumorTemplate[];
  /** guestbook rumors to publish (encrypted seal at guestbook_pk) */
  guestbookRumors: RumorTemplate[];
}

/**
 * Found a new community: mint the secrets and produce the two owner-signed
 * genesis editions (metadata + a public #general channel), plus the owner's
 * own Join (CORD-02 §1).
 */
export function createCommunity(opts: {
  ownerPubkey: string;
  name: string;
  description?: string;
  relays: string[];
}): Genesis {
  const ownerSalt = randomBytes(32);
  const communityRoot = randomBytes(32);
  const cid = toHex(communityId(opts.ownerPubkey, ownerSalt));
  const generalChannelId = toHex(randomBytes(32));

  const material: JoinMaterial = {
    community_id: cid,
    owner: opts.ownerPubkey,
    owner_salt: toHex(ownerSalt),
    community_root: toHex(communityRoot),
    root_epoch: 0,
    channels: [],
    relays: opts.relays,
    name: opts.name,
  };

  const metadata: CommunityMetadata = {
    name: opts.name,
    description: opts.description,
    relays: opts.relays,
  };

  const controlRumors: RumorTemplate[] = [
    buildEdition({ vsk: VSK.METADATA, eid: cid, version: 1, content: JSON.stringify(metadata) }),
    buildEdition({
      vsk: VSK.CHANNEL,
      eid: generalChannelId,
      version: 1,
      content: JSON.stringify({ name: "general", private: false }),
    }),
  ];

  const guestbookRumors: RumorTemplate[] = [
    { kind: 3306, content: "join", tags: [["ms", String(Date.now() % 1000)]] },
  ];

  return { material, generalChannelId, controlRumors, guestbookRumors };
}
