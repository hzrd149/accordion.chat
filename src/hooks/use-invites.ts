import { use$ } from "applesauce-react/hooks";
import { getGiftWrapRumor } from "applesauce-common/helpers/gift-wrap";
import type { InviteWatcher } from "applesauce-concord";
import type { ConcordDirectInvite } from "applesauce-concord/casts";
import { useConcord } from "../lib/concord-context";

// Stable empty fallback so `invites` keeps a constant identity while the stream
// is still empty — avoids re-triggering effects/memos on every render.
const NO_INVITES: ConcordDirectInvite[] = [];

/**
 * The gift-wrap event that carried a decrypted Direct Invite. The watcher keys
 * dismissal by *wrap* id, but a {@link ConcordDirectInvite} casts the inner
 * kind-3313 rumor (a different id), so we correlate back through the wrap's
 * cached rumor. `getGiftWrapRumor` is a synchronous cache read after the wrap
 * has been decrypted (which `autoUnlock` does as invites arrive), so this is
 * cheap and never re-prompts the signer.
 */
export function wrapForInvite(watcher: InviteWatcher, invite: ConcordDirectInvite) {
  return watcher.wraps$.value.find((wrap) => getGiftWrapRumor(wrap)?.id === invite.id);
}

/**
 * Reactive view over the client's CORD-05 §6 Direct Invite inbox. The watcher
 * runs in the background (started at `client.start()`), auto-decrypting invites
 * into `invites$`; this hook just surfaces its reactive state to React. Guards
 * for the watcher being `undefined` before it has started.
 */
export function useInvites() {
  const client = useConcord();
  const watcher = use$(client.directInviteWatcher$);
  const invites = use$(() => watcher?.invites$, [watcher]) ?? NO_INVITES;
  const needsAuth = use$(() => watcher?.needsAuth$, [watcher]) ?? false;
  const status = use$(() => watcher?.status$, [watcher]) ?? "";
  return { watcher, invites, count: invites.length, needsAuth, status };
}
