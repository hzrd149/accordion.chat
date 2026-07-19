import { useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import { CheckCircle2, Info, Loader2, X } from "lucide-react";
import { UserAvatar, UserName } from "../../components/User";
import { pool } from "../../nostr";
import { shortNpub } from "../../lib/util";
import type { PublishStatus } from "./types";
import { EXPIRATIONS, type ExpirationValue } from "./utils";

export function DmSettingsDrawer({
  self,
  peer,
  selfRelays,
  peerRelays,
  expiration,
  onExpirationChange,
  lastPublish,
  onClose,
}: {
  self: string;
  peer: string;
  selfRelays: string[];
  peerRelays: string[];
  expiration: ExpirationValue;
  onExpirationChange: (value: ExpirationValue) => void;
  lastPublish: PublishStatus[];
  onClose: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-[35] bg-black/40 md:hidden" onClick={onClose} />
      <aside className="w-[21.5rem] max-w-[calc(100vw-4rem)] bg-base-200 border-l border-base-300 shadow-xl shrink-0 fixed md:static md:shadow-none right-0 inset-y-0 z-40 max-md:safe-fixed-y flex flex-col min-h-0">
        <div className="h-12 flex items-center gap-2 px-4 border-b border-base-300 shrink-0">
          <Info size={18} className="opacity-60" />
          <span className="font-semibold">DM Settings</span>
          <div className="flex-1" />
          <button className="btn btn-ghost btn-sm btn-circle" onClick={onClose} title="Close settings">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-5">
          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide opacity-60 mb-2">Conversation</h3>
            <div className="flex items-center gap-3 rounded-box bg-base-100 border border-base-300 p-3">
              <UserAvatar pubkey={peer} className="w-10 h-10" />
              <div className="min-w-0">
                <div className="font-semibold truncate"><UserName pubkey={peer} /></div>
                <div className="text-xs opacity-60 font-mono truncate">{shortNpub(peer)}</div>
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide opacity-60 mb-2">Message Expiration</h3>
            <select className="select select-bordered w-full" value={expiration} onChange={(e) => onExpirationChange(e.target.value as ExpirationValue)}>
              {EXPIRATIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
            </select>
            <p className="text-xs opacity-60 mt-2">Stored for this 1:1 conversation. If unset, Accordion guesses from the latest expiring DM.</p>
          </section>

          <RelayStatusList title="Your NIP-17 Inbox Relays" owner={self} relays={selfRelays} empty="You have no DM inbox relays configured." />
          <RelayStatusList title="Their NIP-17 Inbox Relays" owner={peer} relays={peerRelays} empty="No DM inbox relays found for this user." />

          <section>
            <h3 className="text-xs font-bold uppercase tracking-wide opacity-60 mb-2">Last Send</h3>
            {lastPublish.length === 0 ? (
              <p className="text-xs opacity-60">No send attempt recorded in this view yet.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {lastPublish.map((status) => <PublishStatusRow key={status.relay} status={status} />)}
              </div>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}

function RelayStatusList({ title, owner, relays, empty }: { title: string; owner: string; relays: string[]; empty: string }) {
  return (
    <section>
      <h3 className="text-xs font-bold uppercase tracking-wide opacity-60 mb-2">{title}</h3>
      <div className="text-[11px] opacity-50 font-mono mb-2">{shortNpub(owner)}</div>
      {relays.length === 0 ? (
        <p className="text-xs opacity-60 rounded-box bg-base-100 border border-base-300 p-3">{empty}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {relays.map((relay) => <RelayStatusRow key={relay} relay={relay} />)}
        </div>
      )}
    </section>
  );
}

function RelayStatusRow({ relay }: { relay: string }) {
  const inst = useMemo(() => pool.relay(relay), [relay]);
  const information = use$(inst.information$);
  const supported = use$(inst.supported$);
  const icon = use$(inst.icon$);
  const name = information?.name || relay.replace(/^wss?:\/\//, "").replace(/\/$/, "");
  const nip77 = supported?.includes(77);

  return (
    <div className="rounded-box bg-base-100 border border-base-300 p-3 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        {icon ? <img className="w-5 h-5 rounded-full shrink-0" src={icon} alt="" /> : <div className="w-5 h-5 rounded-full bg-base-300 shrink-0" />}
        <div className="font-medium text-sm truncate flex-1">{name}</div>
        <span className={`badge badge-xs ${information ? "badge-success" : "badge-ghost"}`}>{information ? "NIP-11" : "Checking"}</span>
      </div>
      <div className="font-mono text-[11px] opacity-60 truncate mt-1">{relay}</div>
      <div className="flex gap-1 mt-2">
        <span className={`badge badge-xs ${nip77 ? "badge-primary" : "badge-outline"}`}>{nip77 ? "NIP-77 sync" : "No NIP-77"}</span>
      </div>
    </div>
  );
}

function PublishStatusRow({ status }: { status: PublishStatus }) {
  const pending = status.message === "Publishing...";
  return (
    <div className="rounded-box bg-base-100 border border-base-300 p-3 min-w-0">
      <div className="flex items-center gap-2">
        {pending ? <Loader2 size={15} className="animate-spin opacity-60" /> : status.ok ? <CheckCircle2 size={15} className="text-success" /> : <X size={15} className="text-error" />}
        <div className="font-mono text-xs truncate flex-1">{status.relay.replace(/^wss?:\/\//, "")}</div>
        <span className={`badge badge-xs ${pending ? "badge-ghost" : status.ok ? "badge-success" : "badge-error"}`}>{pending ? "Pending" : status.ok ? "Sent" : "Failed"}</span>
      </div>
      {status.message && !pending && <div className="text-[11px] opacity-60 mt-1 truncate">{status.message}</div>}
    </div>
  );
}
