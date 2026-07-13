import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useConcord } from "../lib/concord-context";
import { useCommunity } from "../hooks/use-community";
import { rumorMs } from "applesauce-concord/helpers";
import type { CommunityState } from "applesauce-concord";
import type { ChatMessage } from "../chat/fold";

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
      const id = await client.createNewCommunity(name.trim(), description.trim(), relayList);
      onCreated(id);
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
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={join} disabled={!link.trim() || busy}>
          {busy ? "Joining…" : "Join"}
        </button>
      </div>
    </Modal>
  );
}

export function CreateChannelModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const account = useActiveAccount();
  const pubkey = account?.pubkey ?? "";
  const community = useCommunity(cid);
  const state = use$(() => client.getState$(cid), [cid]) as CommunityState | undefined;
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(false);
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!community) return;
    setBusy(true);
    try {
      const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
      const channelId = await community.createChannel(slug, priv, voice);
      // A private channel's membership is a channel-scoped role (CORD-04 §2, see
      // chat/channel-roles.ts): mint it and self-grant so the creator is roster
      // member #1. Public channels ride the community root — no role needed.
      if (priv && channelId && state) {
        const roleId = await community.createRole(`#${slug}`, state.roles.length + 1, 0n, {
          kind: "channel",
          channel_id: channelId,
        });
        const mine = new Set(state.grants.get(pubkey) ?? []);
        mine.add(roleId);
        await community.grantRoles(pubkey, [...mine]);
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

export function InviteModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const community = useCommunity(cid);
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const started = useRef(false);

  useEffect(() => {
    // Wait for the community engine to resolve, then mint one link per modal open.
    if (started.current || !community) return;
    started.current = true;
    (async () => {
      try {
        const base = window.location.origin;
        setLink(await community.createInvite(base));
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
      }
    })();
  }, [community]);

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold">Invite people</h2>
      <p className="text-sm opacity-60 mb-5">Anyone with this link can join. The link carries no keys — those live encrypted on relays.</p>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      {busy ? (
        <p className="flex items-center gap-2"><span className="loading loading-spinner loading-sm" />Minting invite…</p>
      ) : (
        <>
          <div className="rounded-box bg-base-200 border border-base-300 p-3 font-mono text-xs break-all opacity-70 mb-3">{link}</div>
          <button className="btn btn-primary btn-block" onClick={() => navigator.clipboard.writeText(link)}>
            Copy link
          </button>
        </>
      )}
    </Modal>
  );
}
