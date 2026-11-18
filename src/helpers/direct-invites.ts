import { castUser } from "applesauce-common/casts";
import { DirectInviteFactory } from "@applesauce/concord/factories";
import { buildInviteBundle } from "@applesauce/concord/helpers";
import type { ConcordCommunity } from "@applesauce/concord";
import { accountPublishOptions, requireAccepted, type PublishVerdict } from "./publish";
import { eventStore, pool } from "../nostr";

export type DirectInviteStep = "encrypt" | "relays" | "publish";

export type DirectInviteProgress =
  | { step: "encrypt" }
  | { step: "relays" }
  | { step: "publish"; relays: string[]; inboxRelays: number };

export interface SendDirectInviteOptions {
  channels?: string[];
  /** Called as each stage of the send begins. */
  onProgress?: (progress: DirectInviteProgress) => void;
}

async function recipientInboxRelays(pubkey: string): Promise<string[]> {
  try {
    return (await castUser(pubkey, eventStore).directMessageRelays$.$first(2000, [])) ?? [];
  } catch {
    return [];
  }
}

/** Wrap a Direct Invite for `recipient` and publish it to their inbox relays plus
 *  the community relays. Resolves with every relay's verdict once at least one
 *  accepted; throws `PublishRejectedError` (carrying the verdicts) otherwise. */
export async function sendDirectInvite(
  community: ConcordCommunity,
  recipient: string,
  options: SendDirectInviteOptions = {},
): Promise<readonly PublishVerdict[]> {
  const { onProgress } = options;
  onProgress?.({ step: "encrypt" });
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

  onProgress?.({ step: "relays" });
  const inboxes = await recipientInboxRelays(recipient);
  const relays = [...new Set([...inboxes, ...community.material.relays])];
  if (relays.length === 0) throw new Error("No relays available to deliver the invite");

  onProgress?.({ step: "publish", relays, inboxRelays: inboxes.length });
  return requireAccepted(await pool.publish(relays, wrap, accountPublishOptions(community.signer, community.pubkey)));
}
