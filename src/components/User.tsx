import { useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import { castUser, Profile } from "applesauce-common/casts";
import { castEventStream } from "applesauce-common/observable";
import { of } from "rxjs";
import { eventStore } from "../nostr";
import { colorFor, initials, shortNpub } from "../helpers/util";

type UserPubkey = string | null | undefined;

function isValidPubkey(pubkey: UserPubkey): pubkey is string {
  return typeof pubkey === "string" && /^[0-9a-f]{64}$/.test(pubkey);
}

// Subscribe to a pubkey's kind-0 Profile cast. Reading `user.replaceable(0)`
// queries the EventStore; on a miss it triggers the eventLoader wired in
// nostr.ts (relay hints → indexer relays), so the profile upgrades in place the
// moment it resolves. Returns undefined until then.
function useProfile(pubkey: UserPubkey): Profile | undefined {
  const profile$ = useMemo(
    () => isValidPubkey(pubkey)
      ? castUser(pubkey, eventStore).replaceable(0).pipe(castEventStream(Profile, eventStore))
      : of(undefined),
    [pubkey],
  );
  return use$(profile$);
}

/** A user's display name — the kind-0 name once loaded, else a short npub. */
export function UserName({ pubkey }: { pubkey: UserPubkey }) {
  const profile = useProfile(pubkey);
  if (!isValidPubkey(pubkey)) return <>Unknown user</>;
  return <>{profile?.displayName || shortNpub(pubkey)}</>;
}

/**
 * A user's display name followed by their short npub — e.g.
 * `alice npub1abc…xyz` — so pubkeys in developer/debug views are readable while
 * still exact. Falls back to just the short npub before the profile name loads.
 */
export function UserLabel({ pubkey, className }: { pubkey: UserPubkey; className?: string }) {
  const profile = useProfile(pubkey);
  const npub = isValidPubkey(pubkey) ? shortNpub(pubkey) : "Unknown user";
  return (
    <span className={className}>
      {profile?.displayName ? (
        <>
          {profile.displayName} <span className="opacity-50 font-mono">{npub}</span>
        </>
      ) : (
        <span className="font-mono opacity-70">{npub}</span>
      )}
    </span>
  );
}

/**
 * A user's avatar — the kind-0 picture once loaded, else a colored monogram.
 * `className` controls size/extras (e.g. `w-10 h-10`); the round shape, cover
 * fit and monogram styling are baked in. The monogram keeps its per-pubkey
 * colour via inline style (a genuinely dynamic value).
 */
export function UserAvatar({ pubkey, className = "w-8 h-8" }: { pubkey: UserPubkey; className?: string }) {
  const profile = useProfile(pubkey);
  const validPubkey = isValidPubkey(pubkey) ? pubkey : "";
  const picture = profile?.picture;
  if (picture)
    return <img className={`${className} rounded-full object-cover shrink-0`} src={picture} alt="" />;
  return (
    <div
      className={`${className} rounded-full shrink-0 flex items-center justify-center text-white text-xs font-semibold uppercase`}
      style={{ background: colorFor(validPubkey) }}
    >
      {validPubkey ? initials(validPubkey) : "?"}
    </div>
  );
}
