import type { SyncLoaderStatus } from "applesauce-loaders/loaders";

export interface DmSyncState {
  received: number;
  syncing: boolean;
  error: string | null;
}

export const INITIAL_SYNC: DmSyncState = { received: 0, syncing: true, error: null };

/** Completion includes failed/skipped relays: it must not imply all history arrived. */
export function dmSyncStatus(status: SyncLoaderStatus): DmSyncState {
  const failures = Object.values(status.relays)
    .filter((relay) => relay.state === "error" || relay.state === "skipped")
    .map((relay) => `${relay.relay}: ${relay.error?.message ?? "relay unavailable"}`);
  return { received: status.loaded, syncing: !status.done, error: failures.length ? failures.join("; ") : null };
}
