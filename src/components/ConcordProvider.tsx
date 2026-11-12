import { ConcordClient, logger } from "@applesauce/concord";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { debounceTime } from "rxjs";
import { eventStore, pool } from "../nostr";
import { attachVoiceGc } from "../voice/registry";
import { ClientContext } from "../hooks/use-concord";
import { createConcordUploader } from "../helpers/concord-uploader";
import { createRumorStoreFactory } from "../services/rumor-cache";
import { createConcordStorage } from "../services/concord-storage";

export function ConcordProvider({ children }: { children: (client: ConcordClient) => ReactNode }) {
  const account = useActiveAccount();
  const session = useMemo(() => {
    if (!account) return null;
    const uploader = createConcordUploader(account, account.pubkey, (cid) =>
      client?.getCommunity(cid)?.state$.value.metadata?.blossom_servers,
    );
    const stores = createRumorStoreFactory();
    const storage = createConcordStorage(account.pubkey);
    const client = new ConcordClient({
      signer: account,
      pool,
      eventStore,
      uploader,
      storeFactory: stores,
      storage,
      autoUnlock: true,
      // Local material is committed durably before adoption. This separately
      // publishes the encrypted complete key history for the user's other devices.
      autoSaveCommunityList: true,
      logger: logger.extend("accordion"),
    });
    return { client, stores, storage };
  }, [account]);
  const [failure, setFailure] = useState<{ client: ConcordClient; message: string } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!session) return;
    const { client } = session;
    let cancelled = false;
    // Give extension signers time to inject before the first request.
    const timer = setTimeout(() => {
      void client.start().then(() => {
        if (!cancelled) setFailure(null);
      }).catch((error: unknown) => {
        if (!cancelled) {
          client.stop();
          setFailure({ client, message: error instanceof Error ? error.message : String(error) });
        }
      }).finally(() => {
        // A signer/storage await may finish after account teardown.
        if (cancelled) client.dispose();
      });
    }, 100);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, retry]);

  useEffect(() => {
    if (!session) return;
    const detachVoice = attachVoiceGc(session.client);
    return () => {
      detachVoice();
      session.client.dispose();
      void session.stores.dispose().catch((error: unknown) => console.warn("Could not close community cache", error));
      void session.storage.close().catch((error: unknown) => console.warn("Could not close community storage", error));
    };
  }, [session]);

  if (!session) return null;
  const error = failure?.client === session.client ? failure.message : null;
  return (
    <ClientContext.Provider value={session.client}>
      {error && (
        <div role="alert" className="alert alert-error fixed top-3 left-1/2 -translate-x-1/2 z-50 max-w-lg">
          <span>Could not start your communities: {error}</span>
          <button className="btn btn-sm" onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      )}
      <CommunityKeySync key={account?.id} client={session.client} />
      {children(session.client)}
    </ClientContext.Provider>
  );
}

/** A durable local commit does not guarantee the encrypted relay copy reached
 * another device. Keep unsuccessful/deferred autosaves visible and retryable. */
function CommunityKeySync({ client }: { client: ConcordClient }) {
  const dirty = use$(() => client.communityListDirty$.pipe(debounceTime(1500)), [client]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!dirty) return null;
  return (
    <div role="status" className="alert alert-warning fixed bottom-4 right-4 z-50 max-w-sm">
      <div>
        <p>Community keys have changes waiting to sync to your other devices.</p>
        {error && <p className="text-error">{error}</p>}
      </div>
      <button className="btn btn-sm" disabled={busy} onClick={() => {
        setBusy(true);
        setError("");
        void client.saveCommunityList().catch((reason: unknown) => {
          setError(reason instanceof Error ? reason.message : String(reason));
        }).finally(() => setBusy(false));
      }}>{busy ? "Syncing…" : "Retry"}</button>
    </div>
  );
}
