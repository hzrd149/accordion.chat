import { ConcordClient } from "applesauce-concord";
import { useActiveAccount } from "applesauce-react/hooks";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { eventStore, pool } from "../nostr";
import { attachVoiceGc } from "../voice/registry";
import { ClientContext } from "./concord-context";
import { createConcordUploader } from "./concord-uploader";
import { createRumorStoreFactory } from "./rumor-cache";

export function ConcordProvider({ children }: { children: (client: ConcordClient) => ReactNode }) {
  const account = useActiveAccount();
  // Derive the client from the active account (the constructor is side-effect
  // free); the effect owns its start/stop lifecycle. Deriving instead of setting
  // state in the effect avoids a cascading render on every login.
  const client = useMemo(() => {
    if (!account) return null;
    // The uploader resolves a community's own Blossom servers lazily at upload
    // time (well after the client exists), so a mutable holder is safe here.
    let ref: ConcordClient | null = null;
    const uploader = createConcordUploader(account, account.pubkey, (cid) =>
      ref?.getCommunity(cid)?.state$.value.metadata?.blossom_servers,
    );
    ref = new ConcordClient({
      signer: account,
      pool,
      eventStore,
      uploader,
      // Back each per-plane RumorStore with a nostr-idb cache so a community's
      // decoded chat/control/guestbook history survives reload without refetching
      // (or depending on) relays. See src/app/rumor-cache.ts.
      storeFactory: createRumorStoreFactory(),
      // The client's automatic signer behaviours are all opt-in gates (default
      // off). Turn every one on for the smoothest first-class client experience:
      //  - autoUnlock: decrypt the self-encrypted Community/Invite lists + incoming
      //    Direct Invites as they arrive (no per-item prompt).
      //  - autoAuthenticate: NIP-42-authenticate as the user on the Direct Invite
      //    inbox relays when they challenge, so invites flow in without a manual step.
      //  - autoSaveCommunityList: republish kind 13302 after a sync catches an epoch
      //    up (dirty-flag driven; explicit join/leave/create always publish anyway).
      // (watchDirectInvites already defaults true.)
      autoUnlock: true,
      autoAuthenticate: true,
      autoSaveCommunityList: true,
    });
    return ref;
  }, [account]);

  useEffect(() => {
    if (!client) return;

    // Delay start by 100ms so that nos2x-fox has time to inject the
    setTimeout(() => {

      void client.start();
    }, 100)
    const detachVoice = attachVoiceGc(client);
    return () => {
      detachVoice();
      client.stop();
    };
  }, [client]);

  if (!client) return null;
  return <ClientContext.Provider value={client}>{children(client)}</ClientContext.Provider>;
}
