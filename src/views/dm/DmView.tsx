import { useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { use$ } from "applesauce-react/hooks";
import type { WrappedMessagesClient } from "applesauce-extra/messages";
import { catchError, of } from "rxjs";
import { Menu } from "lucide-react";
import { useMessagesClient } from "../../messages/context";
import { conversationSummaries } from "../../messages/conversations";
import { syncErrors } from "../../messages/status";
import { DmConversation } from "./DmConversation";
import { DmEmpty } from "./DmEmpty";
import { DmSidebar } from "./DmSidebar";
import { isHexPubkey } from "./utils";

interface DmViewProps {
  mobileNav: ReactNode;
  mobileNavOpen: boolean;
  onOpenMobileNav: () => void;
  onCloseMobileNav: () => void;
}

export function DmView(props: DmViewProps) {
  const client = useMessagesClient();
  if (!client) return <div className="p-4" role="status">Starting messages…</div>;
  return <DmInbox key={client.pubkey} {...props} client={client} />;
}

function DmInbox({ client, mobileNav, mobileNavOpen, onOpenMobileNav, onCloseMobileNav }: DmViewProps & { client: WrappedMessagesClient }) {
  const { peerPubkey } = useParams();
  const peer = peerPubkey && isHexPubkey(peerPubkey) ? peerPubkey.toLowerCase() : null;
  const relays = use$(client.relays$);
  const status = use$(client.status$);
  const sync = use$(client.syncStatus$);
  const decryption = use$(client.decryptionState$);
  const auth = use$(client.authRequests$);
  const summaryState = use$(() => conversationSummaries(client).pipe(
    // Keep list errors visible without throwing through React's render.
    catchError((error: unknown) => of(error instanceof Error ? error : new Error(String(error)))),
  ), [client]);
  const conversations = useMemo(() => Array.isArray(summaryState) ? summaryState.map((summary) => ({
    ...summary, peer: summary.participants.find((participant) => participant !== client.pubkey)!,
  })) : [], [client, summaryState]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [authenticating, setAuthenticating] = useState(false);
  const relayErrors = syncErrors(sync);
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  async function authenticate() {
    setAuthenticating(true);
    setError("");
    try {
      const results = await client.authenticateAll();
      if (results.some((result) => result.status === "failed")) {
        setError("Some message relays rejected authentication. Retry or check your signer.");
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setAuthenticating(false); }
  }
  const mobileListButton = <button className="btn btn-ghost btn-sm btn-circle shrink-0 md:hidden" title="DM list" onClick={onOpenMobileNav}><Menu size={22} /></button>;
  return (
    <div className="flex-1 flex min-w-0 min-h-0 bg-base-100 relative overflow-hidden">
      <DmSidebar open={mobileNavOpen} mobileNav={mobileNav} pubkey={client.pubkey} relays={relays}
        syncs={sync?.loaded ?? 0} syncing={busy || status === "loading"}
        syncError={error || (summaryState instanceof Error ? summaryState.message : "") || relayErrors || null}
        onRetrySync={() => void run(() => client.loadHistory())}
        lockedCount={decryption?.locked ?? 0} failed={decryption?.failed ?? []}
        onRetryDecryption={(id) => void run(async () => {
          const envelope = client.eventStore.getEvent(id);
          if (!envelope) throw new Error("Message envelope is no longer cached. Refresh the inbox first.");
          await client.retryDecryption(envelope);
        })}
        unlocking={busy || !!decryption?.pending} conversations={conversations} selectedPeer={peer}
        onClose={onCloseMobileNav} onUnlockAll={() => void run(() => client.unlock())} />
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {!!auth?.length && <div className="alert alert-info rounded-none">
          <span>{auth.length} message relay(s) require authentication.</span>
          <button className="btn btn-sm" disabled={authenticating} onClick={() => void authenticate()}>{authenticating ? "Authenticating…" : "Authenticate"}</button>
        </div>}
        {peer ? <DmConversation key={`${client.pubkey}:${peer}`} client={client} peer={peer} mobileListButton={mobileListButton} /> : <DmEmpty mobileListButton={mobileListButton} />}
      </div>
    </div>
  );
}
