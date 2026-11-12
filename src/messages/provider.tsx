import { useEffect, useState, type ReactNode } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { WrappedMessagesClient } from "applesauce-extra/messages";
import { cacheRequest, eventStore, pool } from "../nostr";
import { MessagesContext } from "./context";
import { openMessageStorage } from "./storage";

export function MessagesProvider({ children }: { children: ReactNode }) {
  const account = useActiveAccount();
  const [session, setSession] = useState<{ account: typeof account; attempt: number; client: WrappedMessagesClient }>();
  const [failure, setFailure] = useState<{ account: typeof account; message: string }>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!account) return;
    let cancelled = false;
    let client: WrappedMessagesClient | undefined;
    let storage: Awaited<ReturnType<typeof openMessageStorage>> | undefined;
    const errors = { unsubscribe() {} };
    const report = (error: unknown) => {
      if (!cancelled) setFailure({ account, message: error instanceof Error ? error.message : String(error) });
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
      const subscription = client.errors$.subscribe(({ operation, error }) => {
        // Sends have their composer outcome; failed envelopes have individual retries.
        if (operation !== "send" && operation !== "decrypt") report(error);
      });
      errors.unsubscribe = () => subscription.unsubscribe();
      if (storageError) report(new Error(`Local storage unavailable; messages and drafts are temporary. ${String(storageError)}`));
      else setFailure(undefined);
      setSession({ account, attempt, client });
      await client.start();
      // Old versions permanently suppressed failed envelopes. The SDK owns retries now.
      try { localStorage.removeItem(`accordion:dm-failed-wraps:${account.pubkey}`); } catch { /* Storage may be unavailable. */ }
    })().catch(report);
    return () => {
      cancelled = true;
      errors.unsubscribe();
      client?.dispose();
      void storage?.close().catch(console.error);
    };
  }, [account, attempt]);

  const client = session && session.account === account && session.attempt === attempt ? session.client : null;
  return (
    <MessagesContext.Provider value={client ?? null}>
      {failure?.account === account && failure && (
        <div role="alert" className="alert alert-warning fixed bottom-4 left-4 z-50 max-w-sm">
          <span>Messages: {failure.message}</span>
          <button className="btn btn-sm" onClick={() => setAttempt((value) => value + 1)}>Restart inbox</button>
          <button className="btn btn-ghost btn-sm" onClick={() => setFailure(undefined)}>Dismiss</button>
        </div>
      )}
      {children}
    </MessagesContext.Provider>
  );
}
