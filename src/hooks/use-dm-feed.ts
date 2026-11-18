import type { Rumor } from "applesauce-core/helpers";
import type { WrappedConversation } from "applesauce-extra/messages";
import { use$ } from "applesauce-react/hooks";
import { useCallback, useRef, useState } from "react";
import { BehaviorSubject, catchError, of, switchMap } from "rxjs";
import { inboxHistory } from "../messages/history";

/** Rumor-store candidates rendered per scroll extension. */
export const DM_PAGE = 50;
/** Start loading this far before the oldest rendered message scrolls into view. */
const MARGIN = "800px 0px";
/** Automatic retry after a failed history load, in milliseconds. */
const RETRY_DELAY = 15_000;

export type DmFeed = {
  /** Newest first; undefined until the rumor store answers. */
  messages: Rumor[] | Error | undefined;
  /** Loading a rumor-store page or an older inbox slice. */
  loading: boolean;
  /** No older messages exist locally or on the inbox relays. */
  done: boolean;
  error?: string;
  /** Ref for the sentinel above the oldest rendered message. */
  sentinel: (element: HTMLElement | null) => (() => void) | undefined;
};

/** Infinite scroll over a conversation's decrypted rumors. The rumor store is the
 * source: scrolling widens the rendered window by a page of stored rumors, and only
 * once the store has no older candidates is the (inbox-wide) history extended. */
export function useDmFeed(conversation: WrappedConversation): DmFeed {
  const history = inboxHistory(conversation.client);
  // Callers key the list by conversation, so the window starts fresh per conversation.
  const [limit$] = useState(() => new BehaviorSubject(DM_PAGE));
  // One observable per conversation: growing the window swaps queries without
  // resetting the rendered list, which keeps the reader's scroll position.
  const messages = use$(() => limit$.pipe(
    switchMap((limit) => conversation.timeline$({ limit })),
    catchError((error: unknown) => of(error instanceof Error ? error : new Error(String(error)))),
  ), [conversation, limit$]);
  const inbox = use$(history.state$);
  const [checking, setChecking] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const busy = useRef(false);

  const loadOlder = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    try {
      const limit = limit$.value;
      // The limit bounds candidates before exact participant matching, so count candidates.
      const candidates = await conversation.rumorStore.getTimeline({ ...conversation.filter, limit });
      if (candidates.length >= limit) {
        limit$.next(limit + DM_PAGE);
        setExhausted(false);
      } else {
        setExhausted(true);
        await history.extend();
      }
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, [conversation, history, limit$]);

  const loading = checking || inbox.loading;
  const done = inbox.done && exhausted;
  const failed = !!inbox.error && !loading;
  const sentinel = useCallback((element: HTMLElement | null) => {
    if (!element || loading || done || messages instanceof Error) return;
    // Re-created after every load, so a still-visible sentinel keeps filling the
    // viewport. After a failure, retry when scrolled back into view or after a delay.
    let armed = !failed;
    let visible = false;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (!visible) armed = true;
      else if (armed) void loadOlder();
    }, { root: element.parentElement, rootMargin: MARGIN });
    observer.observe(element);
    const retry = failed ? setTimeout(() => {
      armed = true;
      if (visible) void loadOlder();
    }, RETRY_DELAY) : undefined;
    return () => {
      observer.disconnect();
      clearTimeout(retry);
    };
  }, [loading, done, failed, messages, loadOlder]);

  return { messages, loading, done, error: inbox.error, sentinel };
}
