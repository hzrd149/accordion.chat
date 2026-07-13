import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { ConcordClient } from "applesauce-concord";
import type { ISigner } from "applesauce-signers";
import { pool, eventStore } from "../nostr";
import { createConcordUploader } from "./concord-uploader";
import { createRumorStoreFactory } from "./rumor-cache";
import { attachVoiceGc } from "../voice/registry";
import { ClientContext } from "./concord-context";

export function ConcordProvider({ children }: { children: (client: ConcordClient) => ReactNode }) {
  const account = useActiveAccount();
  // Derive the client from the active account (the constructor is side-effect
  // free); the effect owns its start/stop lifecycle. Deriving instead of setting
  // state in the effect avoids a cascading render on every login.
  const client = useMemo(() => {
    if (!account) return null;
    const signer = account.signer as ISigner;
    // The uploader resolves a community's own Blossom servers lazily at upload
    // time (well after the client exists), so a mutable holder is safe here.
    let ref: ConcordClient | null = null;
    const uploader = createConcordUploader(signer, account.pubkey, (cid) =>
      ref?.getCommunity(cid)?.state$.value.metadata?.blossom_servers,
    );
    ref = new ConcordClient({
      signer,
      pubkey: account.pubkey,
      pool,
      eventStore,
      uploader,
      // Back each per-plane RumorStore with a nostr-idb cache so a community's
      // decoded chat/control/guestbook history survives reload without refetching
      // (or depending on) relays. See src/app/rumor-cache.ts.
      storeFactory: createRumorStoreFactory(),
      // Auto-decrypt the self-encrypted Community/Invite lists when they arrive
      // (matches the app's prior behaviour of folding them without a prompt).
      autoUnlock: true,
    });
    return ref;
  }, [account]);

  useEffect(() => {
    if (!client) return;
    void client.start();
    const detachVoice = attachVoiceGc(client);
    return () => {
      detachVoice();
      client.stop();
    };
  }, [client]);

  if (!client) return null;
  return <ClientContext.Provider value={client}>{children(client)}</ClientContext.Provider>;
}
