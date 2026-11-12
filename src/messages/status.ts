import type { WrappedMessagesSyncStatus } from "applesauce-extra/messages";

/** SDK completion includes failed/skipped relays, not just successful history. */
export function syncErrors(status: WrappedMessagesSyncStatus | undefined): string | null {
  return status?.mailboxes.flatMap((mailbox) => Object.values(mailbox.relays)
    .filter((relay) => relay.state === "error" || relay.state === "skipped")
    .map((relay) => `${relay.relay}: ${relay.error?.message ?? "relay unavailable"}`)).join("; ") || null;
}
