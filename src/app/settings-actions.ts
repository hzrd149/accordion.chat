// Shared plumbing for the account-settings pages: one ActionRunner per account
// plus the reactive `User` cast used to read the various NIP-51 relay lists,
// blossom servers, and profile out of the single EventStore.
//
// Applesauce actions (AddInboxRelay, AddBlossomServer, UpdateProfile, …) build
// and sign the replaceable events; our publish callback fans them out to a
// sensible relay set so the lists are actually discoverable: the user's own
// outbox relays (10002), the indexer/lookup relays profile+relay-list
// aggregators watch, plus a couple of well-connected general relays.

import { ActionRunner } from "applesauce-actions";
import { castUser } from "applesauce-common/casts";
import type { User } from "applesauce-common/casts";
import { getOutboxes } from "applesauce-core/helpers";
import { eventStore, pool, LOOKUP_RELAYS } from "../nostr";
import type { Signer } from "../concord/stream";

const RELAY_LIST_KIND = 10002;

// Broadly-reachable relays we always include when publishing account lists, so a
// user with no outbox relays yet still lands their profile/lists somewhere.
const FALLBACK_PUBLISH_RELAYS = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"];

/** Where to publish an account-level replaceable event for `pubkey`. */
export function publishTargets(pubkey: string, extra?: string[]): string[] {
  const relayList = eventStore.getReplaceable(RELAY_LIST_KIND, pubkey);
  const outboxes = relayList ? getOutboxes(relayList) : [];
  return [...new Set([...(extra ?? []), ...outboxes, ...LOOKUP_RELAYS, ...FALLBACK_PUBLISH_RELAYS])];
}

/** An ActionRunner bound to `signer`/`pubkey` that publishes to `publishTargets`. */
export function createSettingsRunner(signer: Signer, pubkey: string): ActionRunner {
  return new ActionRunner(eventStore, signer, (event, relays) => {
    // Fire-and-forget: the ActionRunner already saved the event to the store
    // (optimistic UI), so don't block `run()` on relay round-trips.
    const targets = publishTargets(pubkey, relays);
    void Promise.resolve(pool.publish(targets, event)).catch((err) => console.warn("settings publish failed", err));
  });
}

/** The reactive `User` cast for `pubkey` (profile$, inboxes$, blossomServers$, …). */
export function userFor(pubkey: string): User {
  return castUser(pubkey, eventStore);
}

/**
 * Sign, store, and publish a raw replaceable relay-list event. Used for the
 * kind-10086 indexer/lookup list, which has no pre-built applesauce action.
 */
export async function saveRelayList(
  signer: Signer,
  pubkey: string,
  kind: number,
  relays: string[],
): Promise<void> {
  const signed = await signer.signEvent({
    kind,
    content: "",
    tags: relays.map((r) => ["relay", r]),
    created_at: Math.floor(Date.now() / 1000),
  });
  eventStore.add(signed);
  const targets = publishTargets(pubkey);
  void Promise.resolve(pool.publish(targets, signed)).catch((err) => console.warn("relay list publish failed", err));
}
