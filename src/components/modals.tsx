import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useConcord } from "../lib/concord-context";
import { useCommunity } from "../hooks/use-community";
import { useDecryptedImage } from "../hooks/useDecryptedImage";
import { useInvitePreview, type InvitePreview } from "../hooks/use-invite-preview";
import { UserAvatar, UserName } from "./User";
import { rumorMs } from "applesauce-concord/helpers";
import { PERM } from "applesauce-concord";
import type { ConcordInviteLink } from "applesauce-concord";
import type { ChatMessage } from "../chat/fold";

const NO_INVITES: ConcordInviteLink[] = [];

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal modal-open" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
      <div className="modal-backdrop" />
    </div>
  );
}

/** Reusable confirm dialog. `onConfirm` may be async; the button shows a busy
 *  state and any thrown error is surfaced inline until dismissed. */
export function ConfirmModal({
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !busy && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return (
    <Modal onClose={busy ? () => {} : onClose}>
      <h2 className="text-lg font-bold">{title}</h2>
      <div className="py-3 text-sm leading-relaxed">{body}</div>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      <div className="modal-action">
        <button className="btn btn-ghost" disabled={busy} onClick={onClose}>
          {cancelLabel}
        </button>
        <button
          className={`btn ${danger ? "btn-error" : "btn-primary"}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
              onClose();
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
              setBusy(false);
            }
          }}
        >
          {busy ? "…" : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** Debug view: the decoded chat rumor and its derived ordering metadata. */
export function RawEventModal({ message, onClose }: { message: ChatMessage; onClose: () => void }) {
  const { raw } = message;
  const [copied, setCopied] = useState(false);

  // The decoded plane rumor plus the CORD-02 ms ordering basis. (The 1059 wrapper
  // details — wrap id, seal kind, seal event — aren't exposed by the store, which
  // holds decoded rumors, not raw giftwraps.)
  const debug = {
    rumor: raw,
    author: raw.pubkey,
    ms: rumorMs(raw),
  };
  const json = JSON.stringify(debug, null, 2);

  async function copy() {
    await navigator.clipboard.writeText(json);
    setCopied(true);
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold">Raw event</h2>
      <p className="text-sm opacity-60 mb-3">The decoded rumor and its CORD-01 wrapper metadata, for debugging.</p>
      <pre className="max-h-[60vh] overflow-auto rounded-box bg-base-300 p-3 font-mono text-xs leading-relaxed whitespace-pre select-text">{json}</pre>
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
        <button className="btn btn-primary" onClick={copy}>
          {copied ? "Copied!" : "Copy JSON"}
        </button>
      </div>
    </Modal>
  );
}

export function CreateCommunityModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [relays, setRelays] = useState("wss://relay.damus.io\nwss://nos.lol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    setBusy(true);
    setError("");
    try {
      const relayList = relays.split("\n").map((r) => r.trim()).filter(Boolean);
      const community = await client.createNewCommunity(name.trim(), description.trim(), relayList);
      onCreated(community.communityId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold">Create a community</h2>
      <p className="text-sm opacity-60 mb-5">Your community, your rules. It's yours forever — you're the owner.</p>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Community name</label>
        <input className="input input-bordered w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Community" maxLength={64} autoFocus />
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Description (optional)</label>
        <input className="input input-bordered w-full" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What's it about?" />
      </div>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Relays (one per line)</label>
        <textarea className="textarea textarea-bordered w-full" value={relays} onChange={(e) => setRelays(e.target.value)} rows={3} />
      </div>
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={create} disabled={!name.trim() || busy}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </Modal>
  );
}

export function JoinModal({ onClose, onJoined }: { onClose: () => void; onJoined: (id: string) => void }) {
  const client = useConcord();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // Proactively fetch the invite bundle as the link is entered, so we can preview
  // the community before the user commits to joining.
  const preview = useInvitePreview(link);
  const ready = preview.status === "ready" && !preview.expired;

  async function join() {
    setBusy(true);
    setError("");
    try {
      const community = await client.joinByLink(link.trim());
      onJoined(community.communityId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold">Join a community</h2>
      <p className="text-sm opacity-60 mb-5">Paste an invite link. Only people with the link can join.</p>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Invite link</label>
        <input
          className="input input-bordered w-full"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://…/invite/naddr…#…"
          autoFocus
        />
      </div>
      <InvitePreviewCard preview={preview} />
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={join} disabled={!ready || busy}>
          {busy
            ? "Joining…"
            : preview.status === "ready"
              ? `Join ${preview.bundle.name}`
              : "Join"}
        </button>
      </div>
    </Modal>
  );
}

/** A preview of the community an invite link points at (name / icon / inviter),
 *  fetched before the user joins. */
function InvitePreviewCard({ preview }: { preview: InvitePreview }) {
  const bundle = preview.status === "ready" ? preview.bundle : undefined;
  const iconUrl = useDecryptedImage(bundle?.icon);
  if (preview.status === "idle") return null;

  if (preview.status === "loading")
    return (
      <div className="flex items-center gap-2 text-sm opacity-70 mb-4">
        <span className="loading loading-spinner loading-sm" />
        Looking up invite…
      </div>
    );

  if (preview.status === "error")
    return <div className="alert alert-warning text-sm mb-4">{preview.error}</div>;

  // status === "ready"
  const name = preview.bundle.name;
  // Attribution is set to the inviter's hex pubkey by createInvite; only render a
  // profile when it looks like one.
  const inviter = /^[0-9a-f]{64}$/.test(preview.bundle.creator_npub ?? "") ? preview.bundle.creator_npub : undefined;
  return (
    <div className="flex items-center gap-3 p-3 mb-4 rounded-box bg-base-200 border border-base-300">
      <div className="w-12 h-12 shrink-0 rounded-2xl bg-base-300 overflow-hidden flex items-center justify-center font-semibold text-lg">
        {iconUrl ? <img className="w-full h-full object-cover" src={iconUrl} alt="" /> : name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-semibold truncate">{name}</div>
        {inviter && (
          <div className="text-[11px] opacity-60 truncate flex items-center gap-1">
            <UserAvatar pubkey={inviter} className="w-4 h-4" />
            invited by <UserName pubkey={inviter} />
          </div>
        )}
        {preview.expired && <div className="text-error text-[11px] mt-0.5">This invite has expired.</div>}
      </div>
    </div>
  );
}

export function CreateChannelModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const community = useCommunity(cid);
  const state = use$(community?.state$);
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(false);
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!community) return;
    setBusy(true);
    try {
      const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
      const channelId = await community.admin.createChannel(slug, { private: priv, voice });
      // A private channel's membership is a channel-scoped role (CORD-04 §2, see
      // chat/channel-roles.ts): mint it and self-grant so the creator is roster
      // member #1. Public channels ride the community root — no role needed.
      if (priv && channelId && state) {
        const roleId = await community.admin.createRole(`#${slug}`, state.roles.length + 1, 0n, {
          kind: "channel",
          channel_id: channelId,
        });
        const mine = new Set(state.grants.get(pubkey) ?? []);
        mine.add(roleId);
        await community.admin.grantRoles(pubkey, [...mine]);
      }
      onClose();
    } catch {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold mb-4">Create channel</h2>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Channel name</label>
        <input className="input input-bordered w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="new-channel" autoFocus maxLength={64} />
      </div>
      <label className="flex items-center gap-2.5 p-2 rounded-lg cursor-pointer hover:bg-base-200">
        <input type="checkbox" className="checkbox checkbox-sm" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
        <span className="text-sm">Private channel (its own key, only role-holders can read)</span>
      </label>
      <label className="flex items-center gap-2.5 p-2 rounded-lg cursor-pointer hover:bg-base-200">
        <input type="checkbox" className="checkbox checkbox-sm" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        <span className="text-sm">Voice/video channel (end-to-end-encrypted calls)</span>
      </label>
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={create} disabled={!name.trim() || busy}>
          Create
        </button>
      </div>
    </Modal>
  );
}

/**
 * Invite-link management for one community. The user's links live in their
 * private CORD-05 Invite List (kind 13303), which the client's invite manager
 * owns — so links minted on another device show up here too, and revoking one
 * both tombstones the bundle and unregisters it from the community.
 */
export function InviteModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const community = useCommunity(cid);
  const live = use$(client.invites.live$) ?? NO_INVITES;
  const invites = live.filter((i) => i.communityId === cid);
  const canCreate = use$(() => community?.can$(PERM.CREATE_INVITE), [community]) ?? false;
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError("");
    try {
      // Publishes the bundle, registers the link into the community (marking it
      // link-joinable), and saves it to the private Invite List.
      await client.invites.create(cid, { base: window.location.origin, label: label.trim() || undefined });
      setLabel("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: string) {
    setRevoking(token);
    setError("");
    try {
      await client.invites.revoke(token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRevoking(null);
    }
  }

  async function copy(url: string, token: string) {
    await navigator.clipboard.writeText(url);
    setCopied(token);
    setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold">Invite people</h2>
      <p className="text-sm opacity-60 mb-5">Anyone with a link can join. Links carry no keys — those live encrypted on relays.</p>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}

      {invites.length === 0 ? (
        <p className="text-sm opacity-70 mb-4">No active invite links yet.</p>
      ) : (
        <div className="flex flex-col gap-2 mb-4">
          {invites.map((invite) => (
            <div key={invite.token} className="rounded-box bg-base-200 border border-base-300 p-3">
              <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                <span className="font-medium text-sm">{invite.label || "Untitled link"}</span>
                <span className="text-xs opacity-60">{new Date(invite.createdAt * 1000).toLocaleDateString()}</span>
                <div className="ml-auto flex gap-1.5">
                  <button className="btn btn-ghost btn-xs" onClick={() => copy(invite.url, invite.token)}>
                    {copied === invite.token ? "Copied ✓" : "Copy"}
                  </button>
                  <button
                    className="btn btn-ghost btn-xs text-error"
                    disabled={revoking === invite.token}
                    onClick={() => revoke(invite.token)}
                  >
                    {revoking === invite.token ? "Revoking…" : "Revoke"}
                  </button>
                </div>
              </div>
              <div className="font-mono text-[11px] break-all opacity-60">{invite.url}</div>
            </div>
          ))}
        </div>
      )}

      {canCreate ? (
        <div className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="label text-xs font-semibold uppercase opacity-70">Label (optional)</label>
            <input
              className="input input-bordered w-full"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Reddit, Twitter…"
              maxLength={64}
            />
          </div>
          <button className="btn btn-primary" onClick={create} disabled={busy}>
            {busy ? "Minting…" : "New link"}
          </button>
        </div>
      ) : (
        <p className="text-sm opacity-70">You need the Create Invites permission to mint a link.</p>
      )}
    </Modal>
  );
}
