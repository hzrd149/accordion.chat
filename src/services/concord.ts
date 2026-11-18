import { ConcordClient, Databases, Drafts, Media, logger } from "@applesauce/concord";
import type { ConcordDiagnostic } from "@applesauce/concord";
import { BehaviorSubject, distinctUntilChanged, map, Subscription } from "rxjs";
import { accounts, eventStore, pool } from "../nostr";
import { createConcordUploader } from "../helpers/concord-uploader";
import { createConcordDecryptionCache } from "../helpers/concord-decryption-cache";
import { attachVoiceGc } from "../voice/registry";
import { attachUserIndexGc } from "./user-search";
import { createConcordStorage } from "./concord-storage";
import { activeConcordAutomation } from "./concord-automation";
import { observeSigner } from "./signer-activity";
import { observeConcordSync } from "./concord-sync-activity";
import { registerAccountResource } from "./account-lifecycle";
import { attachMediaGc, createMediaTransport, retireLegacyImageCache } from "./concord-media";

export interface ConcordState {
  client: ConcordClient | null;
  accountId?: string;
  status: "idle" | "starting" | "ready" | "error";
  error?: string;
  syncing: boolean;
  syncError?: string;
  diagnostics: ConcordDiagnostic[];
  cleanup: ConcordDiagnostic[];
  retryingCleanup: boolean;
  cleanupError?: string;
}

const emptyState = (): ConcordState => ({
  client: null, status: "idle", syncing: false, diagnostics: [], cleanup: [], retryingCleanup: false,
});
const state = new BehaviorSubject<ConcordState>(emptyState());
export const concordState$ = state.asObservable();
export const concordClient$ = concordState$.pipe(map((value) => value.client), distinctUntilChanged());
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

interface Session {
  client: ConcordClient;
  retired: boolean;
  starting: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retire: () => void;
  close: () => Promise<void>;
}
let session: Session | undefined;
let subscription: Subscription | undefined;

function update(owner: Session, patch: Partial<ConcordState>) {
  if (session === owner && !owner.retired) state.next({ ...state.value, ...patch });
}

function startSession(owner: Session) {
  if (owner.retired || owner.starting) return;
  owner.starting = true;
  update(owner, { status: "starting", error: undefined });
  // Extension signers may be injected shortly after application startup.
  owner.timer = setTimeout(() => {
    owner.timer = undefined;
    if (owner.retired) return;
    void owner.client.start().then(() => {
      update(owner, { status: "ready" });
    }).catch((error: unknown) => {
      if (!owner.retired) {
        owner.client.stop();
        update(owner, { status: "error", error: message(error) });
      }
    }).finally(() => { owner.starting = false; });
  }, 100);
}

function retireSession() {
  const owner = session;
  session = undefined;
  state.next(emptyState());
  if (owner) {
    try { owner.retire(); }
    catch (error) { console.warn("Could not dispose community client", error); }
    finally {
      void owner.close().catch((error: unknown) => console.warn("Could not close community storage", error));
    }
  }
}

function openSession(account: NonNullable<typeof accounts.active>) {
  const stores: Array<{ close(): Promise<unknown> }> = [];
  const detach = new Subscription();
  let client: ConcordClient | undefined;
  let owner: Session | undefined;
  let close: (() => Promise<void>) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (owner) {
      owner.retired = true;
      clearTimeout(owner.timer);
    }
    try { detach.unsubscribe(); }
    finally { client?.dispose(); }
  };
  const closeStores = async () => {
    const results = await Promise.allSettled(stores.map((store) => Promise.resolve().then(() => store.close())));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Could not close community storage");
  };
  try {
    // Register before construction so even partial setup participates in logout.
    close = registerAccountResource(account.pubkey, async () => {
      try { dispose(); } finally { await closeStores(); }
    });
    const databases = Databases.createIndexedDBDatabaseFactory(account.pubkey);
    stores.push(databases);
    const drafts = Drafts.createIndexedDBDraftStore();
    stores.push(drafts);
    const storage = createConcordStorage(account.pubkey);
    stores.push(storage);
    const mediaFactory = Media.createIndexedDBMediaStoreFactory(account.pubkey);
    stores.push(mediaFactory);
    client = new ConcordClient({
      signer: observeSigner(account, account.pubkey), pool, eventStore,
      uploader: createConcordUploader(account, account.pubkey, (cid) =>
        client?.getCommunity(cid)?.state$.value.metadata?.blossom_servers),
      databaseFactory: databases, draftStore: drafts, storage,
      // Membership keys and invite secrets remain device-encrypted.
      decryptionCache: createConcordDecryptionCache(storage, "lists"),
      giftWrapReceiverOptions: { decryptionCache: createConcordDecryptionCache(storage, "gift-wrap") },
      mediaFactory, mediaTransport: createMediaTransport(),
      ...activeConcordAutomation, logger: logger.extend("accordion"),
    });
    owner = { client, retired: false, starting: false, retire: dispose, close };
    session = owner;
    state.next({ ...emptyState(), client, accountId: account.id, status: "starting" });
    const current = owner;
    // Collect before startup, independently of whether the notices are mounted.
    detach.add(client.diagnostics$.subscribe((diagnostic) => {
      if (diagnostic.stage === "direct-invite-receive") return;
      if (diagnostic.stage === "storage-cleanup") {
        update(current, { cleanup: [...state.value.cleanup.filter((item) =>
          item.communityId !== diagnostic.communityId || item.key !== diagnostic.key), diagnostic] });
      } else update(current, { diagnostics: [...state.value.diagnostics.slice(-4), diagnostic] });
    }));
    detach.add(attachVoiceGc(client));
    detach.add(attachUserIndexGc(client));
    detach.add(observeConcordSync(client));
    detach.add(client.schedulePurge());
    detach.add(attachMediaGc(client, account.pubkey));
    startSession(owner);
  } catch (error) {
    session = undefined;
    try { dispose(); }
    catch (disposeError) { console.warn("Could not dispose community client", disposeError); }
    finally { void (close ? close() : closeStores()).catch(console.warn); }
    state.next({ ...emptyState(), status: "error", error: message(error) });
  }
}

/** Application-owned account lifecycle; React subscriptions never start clients. */
export function startConcord() {
  if (subscription) return;
  void retireLegacyImageCache().catch((error: unknown) => console.warn("Could not retire legacy image cache", error));
  subscription = accounts.active$.pipe(distinctUntilChanged()).subscribe((account) => {
    retireSession();
    if (account) openSession(account);
  });
}

export function stopConcord() {
  subscription?.unsubscribe();
  subscription = undefined;
  retireSession();
}

export function retryConcord() {
  if (session) startSession(session);
  else if (subscription && accounts.active) openSession(accounts.active);
}

export async function syncCommunityKeys() {
  const owner = session;
  if (!owner || owner.retired || state.value.syncing) return;
  update(owner, { syncing: true, syncError: undefined });
  try { await owner.client.saveCommunityList(); }
  catch (error) { update(owner, { syncError: message(error) }); }
  finally { update(owner, { syncing: false }); }
}

export function dismissConcordDiagnostics() {
  if (state.value.retryingCleanup) return;
  state.next({ ...state.value, diagnostics: [], cleanup: [], cleanupError: undefined });
}

export async function retryConcordCleanup() {
  const owner = session;
  if (!owner || owner.retired || state.value.retryingCleanup || !state.value.cleanup.length) return;
  const attempted = new Set(state.value.cleanup);
  update(owner, { retryingCleanup: true, cleanupError: undefined });
  try {
    await owner.client.retryStorageCleanup();
    update(owner, { cleanup: state.value.cleanup.filter((item) => !attempted.has(item)) });
  } catch (error) { update(owner, { cleanupError: message(error) }); }
  finally { update(owner, { retryingCleanup: false }); }
}

if (import.meta.hot) import.meta.hot.dispose(stopConcord);
