import { useCallback, useMemo, useState, useTransition } from "react";
import { GiftWrapsModel, WrappedMessagesModel } from "applesauce-common/models";
import { unlockGiftWrap } from "applesauce-common/helpers";
import { unixNow } from "applesauce-core/helpers";
import { mapEventsToStore } from "applesauce-core/observable";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { createSyncLoader } from "applesauce-loaders/loaders";
import { kinds, type NostrEvent } from "nostr-tools";
import { catchError, defer, EMPTY, map, of, retry, startWith, timer } from "rxjs";
import { INITIAL_SYNC, dmSyncStatus } from "./sync-state";
import { eventStore, pool } from "../../nostr";
import type { ConversationPreview } from "./types";
import { NO_MESSAGES, oneToOnePeer, readFailed, SYNC_LOOKBACK_SECONDS, writeFailed } from "./utils";

const NO_EVENTS: NostrEvent[] = [];

export function useDmSync(account: ReturnType<typeof useActiveAccount>, pubkey: string, relays: string[] | undefined) {
  const [attempt, setAttempt] = useState(0);
  const relayKey = relays?.join(",");
  const sync = use$(
    () => !relays?.length || !account ? EMPTY : defer(() => {
      let latest = INITIAL_SYNC;
      return createSyncLoader({ eventStore, pool })({
        relays,
        filter: { kinds: [kinds.GiftWrap], "#p": [pubkey], since: unixNow() - SYNC_LOOKBACK_SECONDS },
        waitForAuth: pubkey,
        onAuthRequired: async ({ url }) => {
          const result = await pool.relay(url).authenticate(account);
          if (!result.ok) throw new Error(result.message || "DM relay authentication rejected");
        },
      }).status$.pipe(
        map(dmSyncStatus),
        map((state) => (latest = state)),
        catchError((error: unknown) => of({
          ...latest, syncing: false, error: error instanceof Error ? error.message : String(error),
        })),
        startWith(INITIAL_SYNC),
      );
    }),
    [account, pubkey, relayKey, attempt],
  );
  const live = use$(
    () => !relays?.length || !account ? EMPTY : pool
      .subscription(relays, { kinds: [kinds.GiftWrap], "#p": [pubkey], since: unixNow() - 60 }, {
        waitForAuth: pubkey,
        onAuthRequired: async ({ relay }) => {
          const result = await relay.authenticate(account);
          if (!result.ok) throw new Error(result.message || "DM relay authentication rejected");
        },
      })
      .pipe(
        mapEventsToStore(eventStore),
        map(() => null as string | null),
        retry({ count: 3, delay: (_error, count) => timer(1000 * 2 ** (count - 1)), resetOnSuccess: true }),
        catchError((error: unknown) => of(error instanceof Error ? error.message : String(error))),
        startWith(null),
      ),
    [account, pubkey, relayKey, attempt],
  );
  return {
    syncs: sync?.received ?? 0,
    syncing: !!relays?.length && (sync?.syncing ?? false),
    syncError: live ?? sync?.error ?? null,
    retrySync: () => setAttempt((value) => value + 1),
  };
}

export function useDmInbox(account: ReturnType<typeof useActiveAccount>, pubkey: string, relays: string[] | undefined) {
  const messages = use$(() => eventStore.model(WrappedMessagesModel, pubkey), [pubkey]) ?? NO_MESSAGES;
  const locked = use$(
    () => eventStore.model(GiftWrapsModel, pubkey, false).pipe(map((events) => events.filter((e) => !readFailed(pubkey).includes(e.id)))),
    [pubkey],
  ) ?? NO_EVENTS;
  const [unlocking, setUnlocking] = useState(false);
  const [, startTransition] = useTransition();

  const sync = useDmSync(account, pubkey, relays);

  const unlockAll = useCallback(async () => {
    if (!account || unlocking || locked.length === 0) return;
    setUnlocking(true);
    const failed = new Set(readFailed(pubkey));
    try {
      for (const gift of locked) {
        if (failed.has(gift.id)) continue;
        try {
          await unlockGiftWrap(gift, account);
        } catch {
          failed.add(gift.id);
        }
      }
      writeFailed(pubkey, [...failed]);
    } finally {
      setUnlocking(false);
    }
  }, [account, locked, pubkey, unlocking]);

  return { messages, locked, ...sync, unlocking, unlockAll, startTransition };
}

export function useConversations(pubkey: string, messages = NO_MESSAGES): ConversationPreview[] {
  return useMemo(() => {
    const byPeer = new Map<string, (typeof messages)[number]>();
    for (const message of messages) {
      const peer = oneToOnePeer(pubkey, message);
      if (!peer) continue;
      const prev = byPeer.get(peer);
      if (!prev || prev.created_at < message.created_at) byPeer.set(peer, message);
    }
    return [...byPeer.entries()].sort((a, b) => b[1].created_at - a[1].created_at);
  }, [messages, pubkey]);
}
