// Private-channel membership, modeled as a channel-scoped role (CORD-04 §2).
//
// Concord has no cryptographic "who's in this channel" list — read access is key
// possession. The spec's observable membership record is instead a *channel-scoped
// role* (`scope = {kind:"channel", channel_id}`): its grant-holders are the
// intended readership, kept in sync with key possession by the app (deliver the
// key on grant via `grantChannelAccess`, rekey on removal via `rotateChannel`).
// These helpers derive that roster from folded Role + Grant editions.

import type { CommunityState } from "applesauce-concord";

/** The role_id of a private channel's membership role, or undefined if none has
 *  been minted yet (a channel created before this convention, or a public one). */
export function channelRoleId(channelId: string, state: CommunityState): string | undefined {
  return state.roles.find((r) => r.scope?.kind === "channel" && r.scope.channel_id === channelId)?.role_id;
}

/**
 * The intended readership of a private channel: every member granted its channel-
 * scoped role, plus the owner (who implicitly holds every key). This is the
 * *entitlement* roster (who was granted), not cryptographic proof of key
 * possession — but since grants and key rotations are kept in step, they track
 * each other. Also the deterministic `keep` set for a channel Rekey.
 */
export function channelRoster(channelId: string, state: CommunityState): string[] {
  const holders = new Set<string>([state.material.owner]);
  const rid = channelRoleId(channelId, state);
  if (rid) {
    for (const member of state.members) {
      if ((state.grants.get(member) ?? []).includes(rid)) holders.add(member);
    }
  }
  return [...holders];
}
