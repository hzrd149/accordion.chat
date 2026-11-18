import { ConcordClient, Databases, Drafts, Media, logger } from "@applesauce/concord";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { debounceTime } from "rxjs";
import { eventStore, pool } from "../nostr";
import { attachVoiceGc } from "../voice/registry";
import { attachUserIndexGc } from "../services/user-search";
import { ClientContext } from "../hooks/use-concord";
import { createConcordUploader } from "../helpers/concord-uploader";
import { createConcordStorage } from "../services/concord-storage";
import { createConcordDecryptionCache } from "../helpers/concord-decryption-cache";
import { activeConcordAutomation } from "../services/concord-automation";
import { observeSigner } from "../services/signer-activity";
import { observeConcordSync } from "../services/concord-sync-activity";
import { ConcordDiagnostics } from "./ConcordDiagnostics";
import { registerAccountResource } from "../services/account-lifecycle";
import { attachMediaGc, createMediaTransport, retireLegacyImageCache } from "../services/concord-media";

export function ConcordProvider({ children }: { children: (client: ConcordClient) => ReactNode }) {
  const account = useActiveAccount();
  const session = useMemo(() => {
    if (!account) return null;
    const uploader = createConcordUploader(account, account.pubkey, (cid) =>
      client?.getCommunity(cid)?.state$.value.metadata?.blossom_servers,
    );
    const databases = Databases.createIndexedDBDatabaseFactory(account.pubkey);
    const drafts = Drafts.createIndexedDBDraftStore();
    const storage = createConcordStorage(account.pubkey);
    const mediaFactory = Media.createIndexedDBMediaStoreFactory(account.pubkey);
    const client = new ConcordClient({
      // Observed so flows like joining can show requests awaiting signer approval.
      signer: observeSigner(account, account.pubkey),
      pool,
      eventStore,
      uploader,
      databaseFactory: databases,
      draftStore: drafts,
      storage,
      // Lists contain membership keys and invite secrets; persist only through
      // the account's device-encrypted adapter, never plaintext localStorage.
      decryptionCache: createConcordDecryptionCache(storage, "lists"),
      mediaFactory,
      mediaTransport: createMediaTransport(import.meta.env.VITE_CONCORD_MEDIA_ORIGINS),
      // Persist both Direct Invite gift-wrap layers so a reload restores them
      // from device-encrypted storage instead of prompting the signer again.
      giftWrapReceiverOptions: {
        decryptionCache: createConcordDecryptionCache(storage, "gift-wrap"),
      },
      ...activeConcordAutomation,
      logger: logger.extend("accordion"),
    });
    return { client, databases, drafts, storage, mediaFactory, retired: false };
  }, [account]);
  const [failure, setFailure] = useState<{ client: ConcordClient; message: string } | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!session) return;
    const { client } = session;
    let cancelled = false;
    // Give extension signers time to inject before the first request.
    const timer = setTimeout(() => {
      if (session.retired) return;
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
    const detachUserIndex = attachUserIndexGc(session.client);
    const detachSyncActivity = observeConcordSync(session.client);
    const stopPurge = session.client.schedulePurge();
    const detachMedia = attachMediaGc(session.client, account!.pubkey);
    void retireLegacyImageCache().catch((error: unknown) => console.warn("Could not retire legacy image cache", error));
    const close = registerAccountResource(account!.pubkey, async () => {
      session.retired = true;
      stopPurge();
      detachSyncActivity();
      detachVoice();
      detachUserIndex();
      detachMedia();
      session.client.dispose();
      const results = await Promise.allSettled([session.databases.close(), session.drafts.close(), session.storage.close(), session.mediaFactory.close()]);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not close community storage");
    });
    return () => { void close().catch((error: unknown) => console.warn("Could not close community storage", error)); };
  }, [session, account]);

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
      <ConcordDiagnostics key={`diagnostics:${account?.id}`} client={session.client} />
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
