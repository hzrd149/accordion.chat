import { castUser } from "applesauce-common/casts";
import { DirectInviteFactory } from "applesauce-concord/factories";
import { buildInviteBundle } from "applesauce-concord/helpers";
import type { ConcordCommunity } from "applesauce-concord";
import { eventStore, pool } from "../nostr";

export interface SendDirectInviteOptions {
  channels?: string[];
}

async function recipientInboxRelays(pubkey: string): Promise<string[]> {
  try {
    return (await castUser(pubkey, eventStore).directMessageRelays$.$first(2000, [])) ?? [];
  } catch {
    return [];
  }
}

export async function sendDirectInvite(
  community: ConcordCommunity,
  recipient: string,
  options: SendDirectInviteOptions = {},
): Promise<string[]> {
  const state = community.state$.value;
  const channels = options.channels?.length ? options.channels : undefined;
  const bundle = buildInviteBundle(community.material, {
    name: state.metadata?.name,
    icon: state.metadata?.icon,
    creator_npub: community.pubkey,
    channels,
  });
  const wrap = await DirectInviteFactory.create(bundle, recipient, community.signer);
  eventStore.add(wrap);

  const inboxes = await recipientInboxRelays(recipient);
  const relays = [...new Set([...inboxes, ...community.material.relays])];
  if (relays.length === 0) throw new Error("No relays available to deliver the invite");
  await pool.publish(relays, wrap);
  return relays;
}
