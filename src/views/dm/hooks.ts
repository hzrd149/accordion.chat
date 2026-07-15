import { useCallback, useMemo, useState, useTransition } from "react";
import { GiftWrapsModel, WrappedMessagesModel } from "applesauce-common/models";
import { unlockGiftWrap } from "applesauce-common/helpers";
import { unixNow } from "applesauce-core/helpers";
import { mapEventsToStore } from "applesauce-core/observable";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { SyncDirection } from "applesauce-relay";
import { kinds, type NostrEvent } from "nostr-tools";
import { catchError, EMPTY, map, tap } from "rxjs";
import { eventStore, pool } from "../../nostr";
import type { ConversationPreview } from "./types";
import { NO_MESSAGES, oneToOnePeer, readFailed, SYNC_LOOKBACK_SECONDS, writeFailed } from "./utils";

const NO_EVENTS: NostrEvent[] = [];

export function useDmSync(pubkey: string, relays: string[] | undefined, onSynced: () => void) {
  use$(
    () =>
      !relays?.length
        ? EMPTY
        : pool
            .sync(
              relays,
              eventStore,
              { kinds: [kinds.GiftWrap], "#p": [pubkey], since: unixNow() - SYNC_LOOKBACK_SECONDS },
              SyncDirection.RECEIVE,
            )
            .pipe(
              tap(onSynced),
              catchError(() => EMPTY),
            ),
    [pubkey, relays?.join(",")],
  );

  use$(
    () =>
      !relays?.length
        ? EMPTY
        : pool
            .subscription(relays, { kinds: [kinds.GiftWrap], "#p": [pubkey], since: unixNow() - 60 })
            .pipe(mapEventsToStore(eventStore), catchError(() => EMPTY)),
    [pubkey, relays?.join(",")],
  );
}

export function useDmInbox(account: ReturnType<typeof useActiveAccount>, pubkey: string, relays: string[] | undefined) {
  const messages = use$(() => eventStore.model(WrappedMessagesModel, pubkey), [pubkey]) ?? NO_MESSAGES;
  const locked = use$(
    () => eventStore.model(GiftWrapsModel, pubkey, false).pipe(map((events) => events.filter((e) => !readFailed(pubkey).includes(e.id)))),
    [pubkey],
  ) ?? NO_EVENTS;
  const [syncs, setSyncs] = useState(0);
  const [unlocking, setUnlocking] = useState(false);
  const [, startTransition] = useTransition();

  useDmSync(pubkey, relays, () => setSyncs((value) => value + 1));

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

  return { messages, locked, syncs, unlocking, unlockAll, startTransition };
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
