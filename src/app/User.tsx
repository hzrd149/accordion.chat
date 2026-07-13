import { useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import { castUser, Profile } from "applesauce-common/casts";
import { castEventStream } from "applesauce-common/observable";
import { eventStore } from "../nostr";
import { colorFor, initials, shortNpub } from "./util";

// Subscribe to a pubkey's kind-0 Profile cast. Reading `user.replaceable(0)`
// queries the EventStore; on a miss it triggers the eventLoader wired in
// nostr.ts (relay hints → indexer relays), so the profile upgrades in place the
// moment it resolves. Returns undefined until then.
function useProfile(pubkey: string): Profile | undefined {
  const profile$ = useMemo(
    () => castUser(pubkey, eventStore).replaceable(0).pipe(castEventStream(Profile, eventStore)),
    [pubkey],
  );
  return use$(profile$);
}

/** A user's display name — the kind-0 name once loaded, else a short npub. */
export function UserName({ pubkey }: { pubkey: string }) {
  const profile = useProfile(pubkey);
  return <>{profile?.displayName || shortNpub(pubkey)}</>;
}

/**
 * A user's avatar — the kind-0 picture once loaded, else a colored monogram.
 * `className` controls size/extras (e.g. `w-10 h-10`); the round shape, cover
 * fit and monogram styling are baked in. The monogram keeps its per-pubkey
 * colour via inline style (a genuinely dynamic value).
 */
export function UserAvatar({ pubkey, className = "w-8 h-8" }: { pubkey: string; className?: string }) {
  const profile = useProfile(pubkey);
  const picture = profile?.picture;
  if (picture)
    return <img className={`${className} rounded-full object-cover shrink-0`} src={picture} alt="" />;
  return (
    <div
      className={`${className} rounded-full shrink-0 flex items-center justify-center text-white text-xs font-semibold uppercase`}
      style={{ background: colorFor(pubkey) }}
    >
      {initials(pubkey)}
    </div>
  );
}
