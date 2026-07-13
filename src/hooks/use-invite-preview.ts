// Proactively fetch an invite link's §1 bundle so the UI can preview the
// community (name, icon, inviter) BEFORE the user commits to joining.
//
// This mirrors what `ConcordClient.joinByLink` fetches, but read-only and
// app-side: parse the link → request the link-signer's invite bundle from the
// link's relay hints → bound + self-certify it (CORD-05 §1). Joining stays a
// separate, explicit step. Expired bundles still preview (only joining refuses),
// so we surface `expired` rather than hiding them.
import { useEffect, useState } from "react";
import { lastValueFrom, timeout } from "rxjs";
import { mapEventsToTimeline } from "applesauce-core";
import type { NostrEvent } from "applesauce-core/helpers/event";
import {
  INVITE_BUNDLE_KIND,
  STOCK_RELAYS,
  getInviteBundle,
  isInviteBundleRevoked,
  isValidInviteBundle,
  parseInviteLink,
  validateInviteBundle,
} from "applesauce-concord/helpers";
import type { InviteBundle } from "applesauce-concord";
import { pool } from "../nostr";

export type InvitePreview =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; bundle: InviteBundle; expired: boolean };

/** Debounce so paste-then-type doesn't fire a request per keystroke. */
const DEBOUNCE_MS = 300;
const FETCH_TIMEOUT_MS = 10000;

export function useInvitePreview(link: string): InvitePreview {
  const [preview, setPreview] = useState<InvitePreview>({ status: "idle" });

  useEffect(() => {
    let cancelled = false;
    // Debounce first (paste-then-type), then do all the work — including every
    // state transition — off the synchronous effect body.
    const timer = setTimeout(async () => {
      const trimmed = link.trim();
      // Only fetch once the input parses as a real invite link — a partial/typed
      // string throws, and we stay idle rather than flashing an error.
      let parsed: ReturnType<typeof parseInviteLink>;
      try {
        parsed = parseInviteLink(trimmed);
      } catch {
        if (!cancelled) setPreview({ status: "idle" });
        return;
      }
      if (!cancelled) setPreview({ status: "loading" });

      try {
        const relays = parsed.bootstrapRelays.length ? parsed.bootstrapRelays : STOCK_RELAYS;
        // Take the accumulated timeline on completion (EOSE), not the timeline
        // operator's seeded immediate `[]`.
        const events = await lastValueFrom(
          pool
            .request(relays, [{ kinds: [INVITE_BUNDLE_KIND], authors: [parsed.linkSigner] }])
            .pipe(mapEventsToTimeline(), timeout(FETCH_TIMEOUT_MS)),
          { defaultValue: [] as NostrEvent[] },
        ).catch(() => [] as NostrEvent[]);

        const live = events
          .filter((e) => isValidInviteBundle(e) && !isInviteBundleRevoked(e))
          .sort((a, b) => b.created_at - a.created_at)[0];
        if (!live) {
          if (!cancelled) setPreview({ status: "error", error: "Invite not found or revoked." });
          return;
        }
        const bundle = validateInviteBundle(getInviteBundle(live, parsed.token));
        if (!bundle) {
          if (!cancelled) setPreview({ status: "error", error: "Invite link failed verification." });
          return;
        }
        const expired = Boolean(bundle.expires_at && Date.now() > bundle.expires_at);
        if (!cancelled) setPreview({ status: "ready", bundle, expired });
      } catch (e) {
        if (!cancelled) setPreview({ status: "error", error: (e as Error).message });
      }
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [link]);

  return preview;
}
