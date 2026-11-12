import { WrappedMessagesClient } from "applesauce-extra/messages";
import { BehaviorSubject, combineLatest, distinctUntilChanged, Observable, Subscription, switchMap } from "rxjs";
import { accounts, cacheRequest, eventStore, pool } from "../nostr";
import { openMessageStorage } from "../messages/storage";

export const messagesClient$ = new BehaviorSubject<WrappedMessagesClient | null>(null);
export const messagesError$ = new BehaviorSubject<string | null>(null);
const restart$ = new BehaviorSubject(0);
let subscription: Subscription | undefined;

export function dismissMessagesError() {
  messagesError$.next(null);
}

export function restartMessages() {
  restart$.next(restart$.value + 1);
}

/** Own the inbox independently of React mounts and route subscriptions. */
export function startMessages() {
  if (subscription) return;
  subscription = combineLatest([accounts.active$.pipe(distinctUntilChanged()), restart$]).pipe(
    switchMap(([account]) => new Observable<WrappedMessagesClient | null>((subscriber) => {
      subscriber.next(null);
      dismissMessagesError();
      if (!account) return;
      let cancelled = false;
      let client: WrappedMessagesClient | undefined;
      let storage: Awaited<ReturnType<typeof openMessageStorage>> | undefined;
      let errors: Subscription | undefined;
      const report = (error: unknown) => {
        if (!cancelled) messagesError$.next(error instanceof Error ? error.message : String(error));
      };
      void (async () => {
        let storageError: unknown;
        try { storage = await openMessageStorage(account.pubkey); }
        catch (error) { storageError = error; }
        if (cancelled) { await storage?.close(); return; }
        client = new WrappedMessagesClient({
          pubkey: account.pubkey, signer: account, eventStore, pool, cacheRequest,
          ...storage, autoUnlock: true, historySpan: 30 * 86400,
        });
        errors = client.errors$.subscribe(({ operation, error }) => {
          // Sends and failed envelopes expose their own retry UI.
          if (operation !== "send" && operation !== "decrypt") report(error);
        });
        if (storageError) report(new Error(`Local storage unavailable; messages and drafts are temporary. ${String(storageError)}`));
        subscriber.next(client);
        await client.start();
        try { localStorage.removeItem(`accordion:dm-failed-wraps:${account.pubkey}`); } catch { /* Storage may be unavailable. */ }
      })().catch(report);
      return () => {
        cancelled = true;
        errors?.unsubscribe();
        client?.dispose();
        void storage?.close().catch(console.error);
      };
    })),
  ).subscribe((client) => messagesClient$.next(client));
}

export function stopMessages() {
  subscription?.unsubscribe();
  subscription = undefined;
  messagesClient$.next(null);
  dismissMessagesError();
}

if (import.meta.hot) import.meta.hot.dispose(stopMessages);
