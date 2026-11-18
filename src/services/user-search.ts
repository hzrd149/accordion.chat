// One local user-search index per community, built from `community.members$`
// and kind-0 profiles and shared by every consumer (composer @-mentions, role
// and channel member pickers, direct invites). Mirrors `voice/registry.ts`:
// created on first use, disposed when the community leaves the client.

import type { ConcordClient, ConcordCommunity } from "@applesauce/concord";
import { castUser, Profile } from "applesauce-common/casts";
import { castEventStream } from "applesauce-common/observable";
import { map } from "rxjs/operators";
import { eventStore } from "../nostr";
import { UserSearchIndex, type UserSearchProfile } from "../helpers/user-search";

const indexes = new Map<ConcordCommunity, UserSearchIndex>();

// The same cast/loader path as `User.tsx`, so missing profiles are fetched by
// the EventStore's automatic loader and shared with the rest of the UI.
function memberProfile$(pubkey: string) {
  return castUser(pubkey, eventStore)
    .replaceable(0)
    .pipe(
      castEventStream(Profile, eventStore),
      map((p): UserSearchProfile | undefined =>
        p ? { displayName: p.displayName, name: p.name, nip05: p.dnsIdentity, picture: p.picture } : undefined,
      ),
    );
}

/** The shared member search index for a community (created on first use). */
export function userIndexFor(community: ConcordCommunity): UserSearchIndex {
  let index = indexes.get(community);
  if (!index) {
    index = new UserSearchIndex(community.members$, memberProfile$);
    indexes.set(community, index);
  }
  return index;
}

/**
 * Dispose indexes whose community the client has dropped (leave/logout), and
 * return a teardown disposing the rest — call it when the client is torn down.
 */
export function attachUserIndexGc(client: ConcordClient): () => void {
  const sub = client.communities$.subscribe(() => {
    const live = new Set(client.communities$.value.map((s) => s.material.community_id));
    for (const [community, index] of indexes) {
      if (!live.has(community.communityId)) {
        index.dispose();
        indexes.delete(community);
      }
    }
  });
  return () => {
    sub.unsubscribe();
    for (const index of indexes.values()) index.dispose();
    indexes.clear();
  };
}
