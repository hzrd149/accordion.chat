import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Subscription } from "rxjs";
import { ArrowLeft, Check, Copy, KeyRound, Lock, Plus, Trash2, X } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { useConcord } from "../hooks/use-concord";
import { useCommunity } from "../hooks/use-community";
import { useInvitePreview, type InvitePreview } from "../hooks/use-invite-preview";
import { INVITE_HOST_PRESETS, inviteHost$, inviteHostBase, rehostInviteUrl, setInviteHost } from "../services/invite-host";
import { UserAvatar, UserName } from "./User";
import { toast, toastSuccess } from "../services/toasts";
import { describeSignerRequest, nextSignerRequestId, signerApprovalHint, signerRequests$, type SignerRequest } from "../services/signer-activity";
import { unixNow } from "applesauce-core/helpers";
import { COMMUNITY_LIST_KIND, ENCRYPTED_SEAL_KIND, PLAINTEXT_SEAL_KIND, rumorMs } from "@applesauce/concord/helpers";
import { CommunityRootUnverifiedError, PERM } from "@applesauce/concord";
import type { ChannelView, ConcordInviteLink } from "@applesauce/concord";
import type { ChatMessage } from "../chat/fold";

const NO_INVITES: ConcordInviteLink[] = [];
const NO_CHANNELS: ChannelView[] = [];

type ExpiryKey = "never" | "1d" | "7d" | "30d";

/** `seconds` is the lifetime added to now; `undefined` mints a link that never expires. */
// Seconds, not milliseconds: CORD-05 `expires_at` is a unix *second* stamp at
// every site, and the package treats `CreateInviteOptions.expiresAt` the same.
const EXPIRY_OPTIONS: { key: ExpiryKey; label: string; seconds?: number }[] = [
  { key: "never", label: "Never" },
  { key: "1d", label: "1 day", seconds: 86_400 },
  { key: "7d", label: "7 days", seconds: 7 * 86_400 },
  { key: "30d", label: "30 days", seconds: 30 * 86_400 },
];

export function Modal({ children, onClose, className = "" }: { children: ReactNode; onClose: () => void; className?: string }) {
  return (
    <div className="modal modal-open safe-modal" onClick={onClose}>
      <div className={`modal-box safe-modal-box ${className}`} onClick={(e) => e.stopPropagation()}>
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

const CREATION_STEPS = [
  ["Generating community keys", "Community keys generated"],
  ["Signing community metadata", "Community metadata signed"],
  ["Setting up pins and #general", "Default channel initialized"],
  ["Signing your membership", "Owner membership initialized"],
  ["Saving and syncing your community keys", "Creation finished"],
] as const;

export function CreateCommunityModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const client = useConcord();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [relays, setRelays] = useState("wss://relay.damus.io\nwss://nos.lol");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(0);
  const [createdId, setCreatedId] = useState<string>();
  const progressSubscription = useRef<Subscription | null>(null);
  useEffect(() => () => progressSubscription.current?.unsubscribe(), []);

  async function create() {
    if (busy) return;
    setBusy(true);
    setError("");
    setCompleted(0);
    const subscriptions = new Subscription();
    progressSubscription.current = subscriptions;
    try {
      const relayList = relays.split("\n").map((r) => r.trim()).filter(Boolean);
      const existing = new Set(client.communities$.value.map((state) => state.material.community_id));
      let observed = false;
      const advance = (step: number) => setCompleted((previous) => Math.max(previous, step));
      // The SDK has no creation-progress callback. Discover the new local engine,
      // then observe its actual milestones; never infer progress from a timer.
      subscriptions.add(client.communities$.subscribe((states) => {
        if (observed) return;
        const state = states.find(({ material }) =>
          !existing.has(material.community_id) && material.owner === client.pubkey && material.name === name.trim(),
        );
        if (!state) return;
        const community = client.getCommunity(state.material.community_id);
        if (!community) return;
        observed = true;
        setCreatedId(community.communityId);
        advance(1);
        subscriptions.add(community.metadata$.subscribe((metadata) => {
          if (metadata) advance(2);
        }));
        subscriptions.add(community.channelViews$.subscribe((channels) => {
          if (channels.length) advance(3);
        }));
        subscriptions.add(community.members$.subscribe((members) => {
          if (members.has(client.pubkey)) advance(4);
        }));
      }));
      const community = await client.createNewCommunity(name.trim(), description.trim(), relayList);
      advance(CREATION_STEPS.length);
      onCreated(community.communityId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    } finally {
      subscriptions.unsubscribe();
    }
  }

  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <h2 className="text-lg font-bold">Create a community</h2>
      <p className="text-sm opacity-60 mb-5">Your community, your rules. It's yours forever — you're the owner.</p>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      {(busy || error || completed > 0) && (
        <div className="rounded-box bg-base-200 p-4 mb-4" aria-busy={busy}>
          <progress
            className={`progress w-full ${error ? "progress-error" : "progress-primary"}`}
            value={completed}
            max={CREATION_STEPS.length}
            aria-label="Community creation progress"
          />
          <ol className="mt-3 space-y-2 text-sm" aria-live="polite" aria-relevant="additions text">
            {CREATION_STEPS.slice(0, Math.min(completed + 1, CREATION_STEPS.length)).map(([pending, done], index) => (
              <li key={pending} className="flex items-center gap-2">
                {index < completed
                  ? <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                  : busy
                    ? <span className="loading loading-spinner loading-xs shrink-0" aria-hidden="true" />
                    : <span className="size-4 shrink-0 text-error" aria-hidden="true">!</span>}
                <span>{index < completed ? done : error ? `${pending} — interrupted` : `${pending}…`}</span>
              </li>
            ))}
          </ol>
          {busy && <p className="mt-3 text-xs opacity-60">Signing and relay synchronization can take a little while. Check your signer for approval requests.</p>}
        </div>
      )}
      <fieldset disabled={busy || !!createdId}>
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
      </fieldset>
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        {error && createdId ? (
          <button className="btn btn-primary" onClick={() => onCreated(createdId)}>Open community</button>
        ) : <button className="btn btn-primary" onClick={create} disabled={!name.trim() || busy}>
          {busy ? "Creating…" : "Create"}
        </button>}
      </div>
    </Modal>
  );
}

const JOIN_STEPS = [
  ["Verifying the invite and the community owner", "Invite and community owner verified"],
  ["Saving your membership keys on this device", "Membership keys saved on this device"],
  ["Announcing your membership to the community", "Membership announced"],
  ["Syncing your community list to your other devices", "Joined"],
] as const;

/** Turn the SDK's protocol-level join errors into something a user can act on. */
function describeJoinError(error: unknown, rejected: SignerRequest | undefined): string {
  if (rejected) return `Your signer did not complete "${describeSignerRequest(rejected)}" (${rejected.error ?? "rejected"}). Joining needs that approval — try again and approve the request.`;
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof CommunityRootUnverifiedError)
    return error.reason === "unreachable"
      ? "Couldn't reach the community's relays to verify its owner. Check your connection and try again."
      : "The community's owner could not be verified from its relays, so the invite can't be trusted yet. Try again later.";
  if (/not found or revoked/.test(message)) return "This invite was not found or has been revoked.";
  if (/expired/.test(message)) return "This invite has expired.";
  return message;
}

export function JoinModal({
  initialLink = "",
  onClose,
  onJoined,
}: {
  initialLink?: string;
  onClose: () => void;
  onJoined: (id: string) => void;
}) {
  const client = useConcord();
  const account = useActiveAccount();
  const [link, setLink] = useState(initialLink);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [completed, setCompleted] = useState(0);
  // Signer requests with an id at or after this one were made during this join attempt.
  const [firstRequest, setFirstRequest] = useState<number | null>(null);
  const allRequests = use$(signerRequests$);
  const requests = firstRequest === null ? [] : (allRequests ?? []).filter((request) => request.id >= firstRequest);
  const progressSubscription = useRef<Subscription | null>(null);
  const closed = useRef(false);
  useEffect(() => () => {
    closed.current = true;
    progressSubscription.current?.unsubscribe();
  }, []);
  // Proactively fetch the invite bundle as the link is entered, so we can preview
  // the community before the user commits to joining.
  const preview = useInvitePreview(link);
  const ready = preview.status === "ready" && !preview.expired;
  const communities = use$(client.communities$);
  const alreadyMember = preview.status === "ready" &&
    !!communities?.some(({ material }) => material.community_id === preview.bundle.community_id);
  const started = busy || !!error || completed > 0;

  async function join() {
    if (busy || preview.status !== "ready") return;
    const cid = preview.bundle.community_id;
    const name = preview.bundle.name;
    setBusy(true);
    setError("");
    setCompleted(0);
    const startId = nextSignerRequestId();
    setFirstRequest(startId);
    const subscriptions = new Subscription();
    progressSubscription.current?.unsubscribe();
    progressSubscription.current = subscriptions;
    const advance = (step: number) => setCompleted((previous) => Math.max(previous, step));
    // The SDK has no join-progress callback. Observe its real milestones — the
    // engine being recorded, our signer being asked for the membership seal and
    // the community list, our Join folding into the roster — never a timer.
    const held = client.getCommunity(cid);
    if (held) advance(2); // already recorded: only the Join and list save remain
    else
      subscriptions.add(client.communities$.subscribe((states) => {
        if (!states.some(({ material }) => material.community_id === cid)) return;
        advance(1);
        const community = client.getCommunity(cid);
        if (community)
          subscriptions.add(community.members$.subscribe((members) => {
            if (members.has(client.pubkey)) advance(3);
          }));
      }));
    subscriptions.add(signerRequests$.subscribe((all) => {
      for (const request of all) {
        if (request.id < startId) continue;
        if (request.method === "sign" && (request.kind === ENCRYPTED_SEAL_KIND || request.kind === PLAINTEXT_SEAL_KIND))
          advance(2);
        if ((request.method === "sign" && request.kind === COMMUNITY_LIST_KIND) || (request.method === "encrypt" && request.self))
          advance(3);
      }
    }));
    try {
      const community = await client.joinByLink(link.trim());
      advance(JOIN_STEPS.length);
      // Hidden mid-join: report the outcome without yanking the user to another page.
      if (closed.current) toastSuccess(`Joined ${name}`);
      else onJoined(community.communityId);
    } catch (e) {
      const rejected = signerRequests$.value.find((request) => request.id >= startId && request.status === "failed");
      const message = describeJoinError(e, rejected);
      if (closed.current) toast(`Could not join ${name}: ${message}`, "error", 10_000);
      setError(message);
      setBusy(false);
    } finally {
      subscriptions.unsubscribe();
    }
  }

  const pending = requests.filter((request) => request.status === "pending");

  return (
    <Modal onClose={() => { if (!busy) onClose(); }}>
      <h2 className="text-lg font-bold">Join a community</h2>
      <p className="text-sm opacity-60 mb-5">Paste an invite link. Only people with the link can join.</p>
      <fieldset disabled={busy}>
        <div className="mb-4">
          <label className="label text-xs font-semibold uppercase opacity-70">Invite link</label>
          <input
            className="input input-bordered w-full"
            value={link}
            onChange={(e) => {
              setLink(e.target.value);
              setError("");
              setCompleted(0);
              setFirstRequest(null);
            }}
            placeholder="https://…/invite/naddr…#…"
            autoFocus
          />
        </div>
      </fieldset>
      <InvitePreviewCard preview={preview} />
      {alreadyMember && !started && (
        <p className="text-xs opacity-70 -mt-2 mb-4">You're already a member. Joining again re-sends your membership and adds any channels this invite grants.</p>
      )}
      {started && (
        <div className="rounded-box bg-base-200 p-4 mb-4" aria-busy={busy}>
          <progress
            className={`progress w-full ${error ? "progress-error" : "progress-primary"}`}
            value={completed}
            max={JOIN_STEPS.length}
            aria-label="Join progress"
          />
          <ol className="mt-3 space-y-2 text-sm" aria-live="polite" aria-relevant="additions text">
            {JOIN_STEPS.slice(0, Math.min(completed + 1, JOIN_STEPS.length)).map(([step, done], index) => (
              <li key={step} className="flex items-center gap-2">
                {index < completed
                  ? <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                  : busy
                    ? <span className="loading loading-spinner loading-xs shrink-0" aria-hidden="true" />
                    : <X className="size-4 shrink-0 text-error" aria-hidden="true" />}
                <span>{index < completed ? done : error ? `${step} — interrupted` : `${step}…`}</span>
              </li>
            ))}
          </ol>
          {requests.length > 0 && (
            <div className="mt-4 pt-3 border-t border-base-300">
              <div className="text-xs font-semibold uppercase opacity-70 mb-2">Signer requests</div>
              <ul className="space-y-1.5 text-sm" aria-live="polite">
                {requests.map((request) => (
                  <li key={request.id} className={`flex items-center gap-2 ${request.status === "pending" ? "font-medium" : "opacity-70"}`}>
                    {request.status === "done"
                      ? <Check className="size-4 shrink-0 text-success" aria-hidden="true" />
                      : request.status === "failed"
                        ? <X className="size-4 shrink-0 text-error" aria-hidden="true" />
                        : <KeyRound className="size-4 shrink-0 text-warning animate-pulse" aria-hidden="true" />}
                    <span>
                      {describeSignerRequest(request)}
                      {request.status === "pending" && " — waiting for approval"}
                      {request.status === "failed" && " — declined"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {pending.length > 0 && (
            <div role="status" className="alert alert-warning text-sm mt-3 py-2">
              <KeyRound className="size-4 shrink-0" aria-hidden="true" />
              <span>Your signer is waiting for you. {signerApprovalHint(account?.type)}</span>
            </div>
          )}
          {busy && pending.length === 0 && (
            <p className="mt-3 text-xs opacity-60">
              Verifying and syncing with the community's relays can take a little while. If your signer asks for approval, it will show up here.
            </p>
          )}
        </div>
      )}
      {error && <div role="alert" className="alert alert-error text-sm mb-3">{error}</div>}
      <div className="modal-action">
        <button className="btn btn-ghost" onClick={onClose} title={busy ? "Joining continues in the background" : undefined}>
          {busy ? "Hide" : "Cancel"}
        </button>
        <button className="btn btn-primary" onClick={join} disabled={!ready || busy}>
          {busy
            ? "Joining…"
            : error
              ? "Try again"
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
  // Before joining there is no authorized community media handle. Do not decrypt
  // invite-supplied pointers through an unscoped fallback; show initials instead.
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
        {name.slice(0, 2).toUpperCase()}
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
  // The granular slices, not the aggregate `state$` — that re-emits on any fold
  // change, including a chat message in any channel.
  const roles = use$(community?.roles$);
  const grants = use$(community?.grants$);
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(false);
  const [view, setView] = useState<"chat" | "forum">("chat");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function create() {
    if (!community) return;
    setBusy(true);
    setError("");
    try {
      const slug = name.trim().toLowerCase().replace(/\s+/g, "-");
      const channelId = await community.admin.createChannel(slug, { private: priv, view });
      // A private channel's membership is a channel-scoped role (CORD-04 §2, see
      // chat/channel-roles.ts): mint it and self-grant so the creator is roster
      // member #1. Public channels ride the community root — no role needed.
      if (priv && channelId && roles && grants) {
        const roleId = await community.admin.createRole(`#${slug}`, roles.length + 1, 0n, {
          kind: "channel",
          channel_id: channelId,
        });
        const mine = new Set(grants.get(pubkey) ?? []);
        mine.add(roleId);
        await community.admin.grantRoles(pubkey, [...mine]);
      }
      onClose();
    } catch (e) {
      // createChannel now asserts a 64-byte cap on the name before minting the
      // channel key, so an over-long name is a real, reportable refusal rather
      // than a silent no-op.
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      <h2 className="text-lg font-bold mb-4">Create channel</h2>
      <label className="label text-xs font-semibold uppercase opacity-70">Channel layout</label>
      <select className="select select-bordered w-full mb-4" value={view}
        onChange={(event) => setView(event.target.value as "chat" | "forum")}>
        <option value="chat">Chat</option>
        <option value="forum">Forum (titled posts with replies)</option>
      </select>
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">Channel name</label>
        <input className="input input-bordered w-full" value={name} onChange={(e) => setName(e.target.value)} placeholder="new-channel" autoFocus maxLength={64} />
      </div>
      <label className="flex items-center gap-2.5 p-2 rounded-lg cursor-pointer hover:bg-base-200">
        <input type="checkbox" className="checkbox checkbox-sm" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
        <span className="text-sm">Private channel (only people you add can read it)</span>
      </label>
      <p className="text-xs opacity-60 px-2 pt-1">Every channel supports end-to-end-encrypted calls — start one from the channel header.</p>
      {error && <div className="alert alert-error text-sm mt-3">{error}</div>}
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
 *
 * Opens on the list of live links; the header's "New invite" button swaps the
 * whole modal over to the create form, which returns to the list once minted.
 */
export function InviteModal({ cid, onClose }: { cid: string; onClose: () => void }) {
  const client = useConcord();
  const community = useCommunity(cid);
  const live = use$(client.invites.live$) ?? NO_INVITES;
  const invites = live.filter((i) => i.communityId === cid);
  const canCreate = use$(() => community?.can$(PERM.CREATE_INVITE), [community]) ?? false;
  const registered = use$(community?.inviteLinks$);
  const allChannels = use$(community?.channelViews$) ?? NO_CHANNELS;
  const channelNames = new Map(allChannels.map((c) => [c.channel_id, c.name]));
  const hostId = use$(inviteHost$);
  const hostBase = inviteHostBase(hostId);
  const [view, setView] = useState<"list" | "create">("list");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  // Captured once: the expiry countdowns are rendered against a fixed "now" so
  // render stays pure (see ExpiryText). Unix seconds, to match `expiresAt`.
  const [now] = useState(() => unixNow());

  // Links registered in the community by other members: we only see their
  // link_signer coordinates (no URL or token), and can't revoke them.
  const mine = new Set(invites.map((i) => i.signerPubkey));
  const others = registered ? [...registered].filter((pk) => !mine.has(pk)).length : 0;

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
    await navigator.clipboard.writeText(rehostInviteUrl(url, hostBase));
    setCopied(token);
    setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
  }

  if (view === "create")
    return (
      <Modal onClose={onClose} className="max-w-2xl">
        <CreateInviteForm
          cid={cid}
          hostId={hostId}
          base={hostBase}
          channels={allChannels}
          onBack={() => setView("list")}
          onCreated={() => setView("list")}
        />
      </Modal>
    );

  return (
    <Modal onClose={onClose} className="max-w-2xl">
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <h2 className="text-lg font-bold flex-1">Invite links</h2>
        <InviteHostSelect value={hostId} />
        {canCreate && (
          <button className="btn btn-primary btn-sm gap-1.5" onClick={() => setView("create")}>
            <Plus size={16} />
            New invite
          </button>
        )}
      </div>
      {!canCreate && <p className="text-sm opacity-60 mb-3">You need the Create Invites permission to create links.</p>}
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}

      {invites.length === 0 ? (
        <p className="py-8 text-center text-sm opacity-60">No active invite links.</p>
      ) : (
        <ul className="-mx-2 max-h-[60vh] overflow-y-auto">
          {invites.map((invite) => (
            <InviteRow
              key={invite.token}
              invite={invite}
              url={rehostInviteUrl(invite.url, hostBase)}
              channelNames={channelNames}
              now={now}
              copied={copied === invite.token}
              revoking={revoking === invite.token}
              onCopy={() => copy(invite.url, invite.token)}
              onRevoke={() => revoke(invite.token)}
            />
          ))}
        </ul>
      )}

      {others > 0 && (
        <p className="text-xs opacity-50 mt-3">
          +{plural(others, "link")} by other members
        </p>
      )}
    </Modal>
  );
}

function CreateInviteForm({
  cid,
  hostId,
  base,
  channels,
  onBack,
  onCreated,
}: {
  cid: string;
  hostId: string;
  base: string;
  channels: ChannelView[];
  onBack: () => void;
  onCreated: () => void;
}) {
  const client = useConcord();
  // Only channels we hold a key for can be granted — the package throws on an id
  // that isn't in our material, and we couldn't hand over a key we don't have.
  // `accessible` is the package's own key-presence flag, and it re-emits on a key
  // grant alone, so a channel we were just given shows up here without waiting
  // for an unrelated control-plane fold.
  const grantable = channels.filter((c) => c.private && c.accessible);
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ExpiryKey>("never");
  const [granted, setGranted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function toggleChannel(id: string) {
    setGranted((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));
  }

  async function create() {
    setBusy(true);
    setError("");
    try {
      const ttl = EXPIRY_OPTIONS.find((o) => o.key === expiry)?.seconds;
      // Publishes the bundle, registers the link into the community (marking it
      // link-joinable), and saves it to the private Invite List.
      await client.invites.create(cid, {
        base,
        label: label.trim() || undefined,
        expiresAt: ttl ? unixNow() + ttl : undefined,
        // Omitted when empty: a link grants no private channels unless asked.
        channels: granted.length ? granted : undefined,
      });
      onCreated();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex items-center gap-2 mb-5">
        <button className="btn btn-ghost btn-sm btn-square -ml-2" aria-label="Back to invites" disabled={busy} onClick={onBack}>
          <ArrowLeft size={18} />
        </button>
        <h2 className="text-lg font-bold">New invite</h2>
      </div>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}

      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70" htmlFor="invite-label">
          Label (optional)
        </label>
        <input
          id="invite-label"
          className="input input-bordered w-full"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Reddit, Twitter…"
          maxLength={64}
          autoFocus
        />
      </div>

      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70" htmlFor="invite-host">
          Opens in
        </label>
        <InviteHostSelect id="invite-host" value={hostId} className="w-full" />
      </div>

      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70" htmlFor="invite-expiry">
          Expires after
        </label>
        <select
          id="invite-expiry"
          className="select select-bordered w-full"
          value={expiry}
          onChange={(e) => setExpiry(e.target.value as ExpiryKey)}
        >
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {grantable.length > 0 && (
        <div className="mb-2">
          <div className="flex items-center">
            <span className="label text-xs font-semibold uppercase opacity-70 flex-1">Private channels to include</span>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setGranted(grantable.map((c) => c.channel_id))}>
              All
            </button>
            <button type="button" className="btn btn-ghost btn-xs" onClick={() => setGranted([])}>
              None
            </button>
          </div>
          <p className="text-xs opacity-60 mb-1">Link holders can read their full history.</p>
          {grantable.map((c) => (
            <label
              key={c.channel_id}
              className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 rounded-lg cursor-pointer hover:bg-base-200"
              htmlFor={`grant-${c.channel_id}`}
            >
              <input
                id={`grant-${c.channel_id}`}
                type="checkbox"
                className="checkbox checkbox-sm"
                checked={granted.includes(c.channel_id)}
                onChange={() => toggleChannel(c.channel_id)}
              />
              <Lock size={14} className="opacity-60" />
              <span className="text-sm">{c.name}</span>
            </label>
          ))}
        </div>
      )}

      <div className="modal-action">
        <button className="btn btn-ghost" disabled={busy} onClick={onBack}>
          Cancel
        </button>
        <button className="btn btn-primary" onClick={create} disabled={busy}>
          {busy ? "Creating…" : "Create invite"}
        </button>
      </div>
    </>
  );
}

/** Which Concord client the shown/copied links open in. "This app" covers the
 *  Accordion preset when we're already running on accordion.chat. */
function InviteHostSelect({ value, id, className = "select-sm w-auto" }: { value: string; id?: string; className?: string }) {
  const presets = INVITE_HOST_PRESETS.filter((p) => !p.base || p.base !== window.location.origin);
  return (
    <select
      id={id}
      className={`select ${className}`}
      aria-label="Open links in"
      value={presets.some((p) => p.id === value) ? value : "this"}
      onChange={(e) => setInviteHost(e.target.value)}
    >
      {presets.map((p) => (
        <option key={p.id} value={p.id}>
          {p.base ? `${p.label} · ${new URL(p.base).host}` : "This app"}
        </option>
      ))}
    </select>
  );
}

function InviteRow({
  invite,
  url,
  channelNames,
  now,
  copied,
  revoking,
  onCopy,
  onRevoke,
}: {
  invite: ConcordInviteLink;
  url: string;
  channelNames: Map<string, string>;
  now: number;
  copied: boolean;
  revoking: boolean;
  onCopy: () => void;
  onRevoke: () => void;
}) {
  return (
    <li className="flex items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-base-200">
      <div className="min-w-0 flex-1">
        <div className="font-medium truncate">{invite.label || "Untitled link"}</div>
        <div className="text-xs opacity-60 truncate">
          <ExpiryText expiresAt={invite.expiresAt} now={now} />
          {" · "}Created {new Date(invite.createdAt * 1000).toLocaleDateString()}
        </div>
        {invite.channels?.length ? (
          <div className="text-xs text-warning flex items-center gap-1 truncate">
            <Lock size={11} className="shrink-0" />
            Includes {invite.channels.map((id) => channelNames.get(id) ?? "a private channel").join(", ")}
          </div>
        ) : null}
        <div className="font-mono text-xs truncate opacity-40" title={url}>{url}</div>
      </div>
      <button className="btn btn-ghost btn-sm btn-square" title="Copy link" aria-label="Copy link" onClick={onCopy}>
        {copied ? <Check size={16} className="text-success" /> : <Copy size={16} />}
      </button>
      <button
        className="btn btn-ghost btn-sm btn-square text-error"
        title="Revoke link"
        aria-label="Revoke link"
        disabled={revoking}
        onClick={onRevoke}
      >
        {revoking ? <span className="loading loading-spinner loading-xs" /> : <Trash2 size={16} />}
      </button>
    </li>
  );
}

/** `now` is captured once by the modal rather than read here: reading the clock
 *  during render is impure, and the countdown has no reason to move mid-modal.
 *  Both `expiresAt` and `now` are unix seconds (CORD-05). */
function ExpiryText({ expiresAt, now }: { expiresAt?: number; now: number }) {
  if (!expiresAt) return <>Never expires</>;
  const left = expiresAt - now;
  if (left <= 0) return <span className="text-error">Expired</span>;
  // Round, never ceil: a link minted seconds ago with a 7-day lifetime has a hair
  // over 7 days left, which ceil would advertise as 8.
  const hours = Math.round(left / 3_600);
  const label =
    hours < 24 ? plural(Math.max(1, hours), "hour") : plural(Math.round(hours / 24), "day");
  return <>Expires in {label}</>;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}
