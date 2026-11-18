import { unixNow } from "applesauce-core/helpers";
import type { WrappedMessagesClient } from "applesauce-extra/messages";
import { BehaviorSubject } from "rxjs";
import { syncErrors } from "./status";

/** The client's initial logical lookback, also the first history step. */
export const HISTORY_SPAN = 30 * 86400;
/** Past this step the next extension reaches back to the beginning of time. */
const MAX_STEP = 2 * 365 * 86400;

export type InboxHistoryState = {
  /** The oldest logical timestamp whose inbox envelopes have been loaded. */
  coverage: number;
  loading: boolean;
  /** Coverage reached the beginning of time. */
  done: boolean;
  error?: string;
};

export type InboxHistory = {
  readonly state$: BehaviorSubject<InboxHistoryState>;
  /** Loads the next older inbox slice; concurrent calls share one load. */
  extend(): Promise<void>;
};

type HistorySource = Pick<WrappedMessagesClient, "loadHistory">;

/** NIP-17 envelopes are inbox-wide with randomized timestamps, so history can only
 * be extended for the whole inbox, never per conversation. Conversations page
 * through the rumor store and call `extend` only once their local history runs out. */
export function createInboxHistory(client: HistorySource, now = unixNow()): InboxHistory {
  const state$ = new BehaviorSubject<InboxHistoryState>({ coverage: Math.max(0, now - HISTORY_SPAN), loading: false, done: now <= HISTORY_SPAN });
  let step = HISTORY_SPAN;
  let pending: Promise<void> | undefined;

  async function load() {
    const { coverage } = state$.value;
    const since = step >= MAX_STEP ? 0 : Math.max(0, coverage - step);
    state$.next({ ...state$.value, loading: true, error: undefined });
    try {
      const status = await client.loadHistory({ since, until: coverage });
      const relays = status.mailboxes.flatMap((mailbox) => Object.values(mailbox.relays));
      const failed = relays.length > 0 && relays.every((relay) => relay.state === "error" || relay.state === "skipped");
      if (failed) {
        state$.next({ ...state$.value, loading: false, error: syncErrors(status) ?? "Every inbox relay failed" });
        return;
      }
      // Quiet periods add no envelopes, so reach further next time.
      step = status.loaded === 0 ? step * 2 : HISTORY_SPAN;
      state$.next({ coverage: since, loading: false, done: since === 0, error: syncErrors(status) ?? undefined });
    } catch (reason) {
      state$.next({ ...state$.value, loading: false, error: reason instanceof Error ? reason.message : String(reason) });
    }
  }

  return {
    state$,
    extend() {
      if (state$.value.done) return Promise.resolve();
      pending ??= load().finally(() => { pending = undefined; });
      return pending;
    },
  };
}

const histories = new WeakMap<HistorySource, InboxHistory>();

/** The shared history for one client lifetime. */
export function inboxHistory(client: HistorySource): InboxHistory {
  let history = histories.get(client);
  if (!history) histories.set(client, history = createInboxHistory(client));
  return history;
}
