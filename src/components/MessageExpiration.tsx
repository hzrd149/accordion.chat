import type { ConcordCommunity } from "@applesauce/concord";
import { PERM } from "@applesauce/concord";
import { use$ } from "applesauce-react/hooks";
import { useState } from "react";
import { toastError } from "../services/toasts";

export function MessageExpiration({ community }: { community: ConcordCommunity }) {
  const metadata = use$(community.metadata$);
  const allowed = use$(() => community.can$(PERM.MANAGE_METADATA), [community]);
  const dissolved = use$(community.dissolved$);
  const [busy, setBusy] = useState(false);
  const seconds = metadata?.message_expiration ?? 0;
  const choices = new Map([[0, "Off"], [3600, "1 hour"], [86400, "1 day"], [604800, "1 week"], [2592000, "30 days"]]);
  if (!choices.has(seconds)) choices.set(seconds, `${seconds} seconds`);
  return <section className="mt-6">
    <h3 className="font-semibold">Disappearing messages</h3>
    <p className="text-sm opacity-70 mb-2">Applies to new messages in every channel. Existing messages keep their original timer.</p>
    <select className="select select-bordered" aria-label="Message expiration"
      value={seconds} disabled={!allowed || dissolved || busy}
      onChange={(event) => {
        setBusy(true);
        void community.setMessageExpiration(Number(event.target.value))
          .catch((reason: unknown) => toastError(reason, "Failed to update message expiration"))
          .finally(() => setBusy(false));
      }}>
      {[...choices].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select>
  </section>;
}
