import { useState } from "react";
import type { ReactNode } from "react";
import { Inbox, Lock, RefreshCw, ShieldCheck } from "lucide-react";
import { useNavigate } from "react-router";
import type { ConcordDirectInvite } from "applesauce-concord/casts";
import { useConcord } from "../lib/concord-context";
import { useInvites, wrapForInvite } from "../hooks/use-invites";
import { useDecryptedImage } from "../hooks/useDecryptedImage";
import { UserAvatar, UserName } from "../components/User";

/**
 * The Direct Invites (CORD-05 §6) page: a normal in-shell view (the community
 * rail stays put) listing the pending invites the user has been handed directly
 * (gift-wrapped to their npub). Accepting keeps the keys and joins the
 * community; dismissing hides the invite locally (the keys are discarded, per
 * spec — decline = forget). The watcher syncs in the background; the Sync button
 * forces a fresh fetch.
 */
export function InvitesView({ mobileNav }: { mobileNav: ReactNode }) {
  const { watcher, invites, needsAuth, status } = useInvites();
  const [syncing, setSyncing] = useState(false);

  async function sync() {
    if (!watcher || syncing) return;
    setSyncing(true);
    try {
      if (needsAuth) await watcher.authenticateUser();
      await watcher.refresh();
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-base-100">
      <div className="h-12 safe-topbar flex items-center px-4 gap-2 border-b border-base-300 shadow-sm shrink-0">
        {mobileNav}
        <Inbox size={20} className="text-base-content/60" />
        <span className="font-semibold text-base-content">Invites</span>
        {invites.length > 0 && <span className="badge badge-primary badge-sm">{invites.length}</span>}
        <div className="flex-1" />
        <button className="btn btn-ghost btn-sm gap-2" title="Sync invites" onClick={sync} disabled={syncing}>
          <RefreshCw size={16} className={syncing ? "animate-spin" : ""} />
          <span className="max-md:hidden">{syncing ? "Syncing…" : "Sync"}</span>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 md:p-10">
        <div className="max-w-[680px] mx-auto">
          <p className="text-sm opacity-70 leading-relaxed mb-5 flex items-start gap-2">
            <Lock size={16} className="mt-0.5 shrink-0" />
            <span>
              Someone handed you the keys to an end-to-end-encrypted community. Nothing connects to
              its relays until you accept — and no host can see its messages.
            </span>
          </p>

          {needsAuth && (
            <div className="alert alert-warning text-sm mb-4">
              Your invite inbox relay needs authentication. Press <strong>Sync</strong> to authenticate
              and check for invites.
            </div>
          )}
          {status && !syncing && <div className="text-xs opacity-60 mb-3">{status}</div>}

          {invites.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 text-center text-base-content/60 py-20">
              <Inbox size={44} />
              <div className="text-base-content font-bold">No pending invites</div>
              <p className="m-0 max-w-[280px] text-[13px]">
                Direct invites people send you will show up here. Press Sync to check for new ones.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {invites.map((invite) => (
                <InviteRow key={invite.id} invite={invite} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InviteRow({ invite }: { invite: ConcordDirectInvite }) {
  const client = useConcord();
  const { watcher } = useInvites();
  const navigate = useNavigate();
  const bundle = invite.bundle;
  const iconUrl = useDecryptedImage(bundle?.icon);
  const [busy, setBusy] = useState<"accept" | "dismiss" | null>(null);
  const [error, setError] = useState("");

  // A valid invite always carries a bundle (invites$ only surfaces valid ones),
  // but guard defensively.
  const name = bundle?.name ?? "Encrypted community";

  async function accept() {
    if (!bundle || busy) return;
    setBusy("accept");
    setError("");
    try {
      const community = await client.joinByBundle(bundle);
      // Once joined, drop the invite from the list too (decline-after-join is
      // moot; keeping it would re-offer a community we're already in).
      if (watcher) {
        const wrap = wrapForInvite(watcher, invite);
        if (wrap) await watcher.dismiss(wrap);
      }
      navigate(`/c/${community.communityId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function dismiss() {
    if (!watcher || busy) return;
    setBusy("dismiss");
    try {
      const wrap = wrapForInvite(watcher, invite);
      if (wrap) await watcher.dismiss(wrap);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex items-center gap-3 p-3 rounded-box bg-base-200 border border-base-300 max-sm:flex-col max-sm:items-stretch">
      <div className="flex min-w-0 items-center gap-3">
        <div className="w-12 h-12 shrink-0 rounded-2xl bg-base-300 overflow-hidden flex items-center justify-center font-semibold text-lg">
          {iconUrl ? <img className="w-full h-full object-cover" src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate flex items-center gap-1.5">
            <ShieldCheck size={15} className="text-success shrink-0" />
            {name}
          </div>
          <div className="text-[11px] opacity-60 truncate flex items-center gap-1 mt-0.5">
            <UserAvatar pubkey={invite.inviter} className="w-4 h-4" />
            invited by <UserName pubkey={invite.inviter} />
          </div>
          {error && <div className="text-error text-[11px] mt-0.5">{error}</div>}
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 max-sm:justify-end">
        <button className="btn btn-ghost btn-sm" onClick={dismiss} disabled={busy !== null}>
          {busy === "dismiss" ? "…" : "Dismiss"}
        </button>
        <button className="btn btn-primary btn-sm" onClick={accept} disabled={busy !== null}>
          {busy === "accept" ? "Joining…" : "Accept"}
        </button>
      </div>
    </div>
  );
}
