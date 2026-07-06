import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useActiveAccount } from "applesauce-react/hooks";
import { ConcordClient } from "../concord/client";
import type { Signer } from "../concord/stream";

const ClientContext = createContext<ConcordClient | null>(null);

export function useConcord(): ConcordClient {
  const c = useContext(ClientContext);
  if (!c) throw new Error("ConcordClient not available");
  return c;
}

export function ConcordProvider({ children }: { children: (client: ConcordClient) => ReactNode }) {
  const account = useActiveAccount();
  const [client, setClient] = useState<ConcordClient | null>(null);

  useEffect(() => {
    if (!account) {
      setClient(null);
      return;
    }
    const c = new ConcordClient(account.signer as Signer, account.pubkey);
    setClient(c);
    void c.start();
    return () => c.stop();
  }, [account]);

  if (!client) return null;
  return <ClientContext.Provider value={client}>{children(client)}</ClientContext.Provider>;
}
