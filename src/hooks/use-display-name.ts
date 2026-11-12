import { useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import { castUser, Profile } from "applesauce-common/casts";
import { castEventStream } from "applesauce-common/observable";
import { eventStore } from "../nostr";
import { shortNpub } from "../lib/util";

/**
 * A user's display name as a plain string, for places that can't render
 * `<UserName>` (placeholders, titles, <option>s). Short npub until the profile loads.
 */
export function useDisplayName(pubkey: string): string {
  const profile$ = useMemo(
    () => castUser(pubkey, eventStore).replaceable(0).pipe(castEventStream(Profile, eventStore)),
    [pubkey],
  );
  const profile = use$(profile$) as Profile | undefined;
  return profile?.displayName || shortNpub(pubkey);
}
