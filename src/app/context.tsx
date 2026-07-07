import { useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { ConcordClient } from "../concord/client";
import type { Signer } from "../concord/stream";
import { ClientContext } from "./concord-context";

export function ConcordProvider({ children }: { children: (client: ConcordClient) => ReactNode }) {
  const account = useActiveAccount();
  // Derive the client from the active account (the constructor is side-effect
  // free); the effect owns its start/stop lifecycle. Deriving instead of setting
  // state in the effect avoids a cascading render on every login.
  const client = useMemo(
    () => (account ? new ConcordClient(account.signer as Signer, account.pubkey) : null),
    [account],
  );

  useEffect(() => {
    if (!client) return;
    void client.start();
    return () => client.stop();
  }, [client]);

  if (!client) return null;
  return <ClientContext.Provider value={client}>{children(client)}</ClientContext.Provider>;
}
