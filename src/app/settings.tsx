import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Flower2, Inbox, Mailbox, Radar, Star, Trash2, User as UserIcon, X } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { CreateProfile, UpdateProfile } from "applesauce-actions/actions/profile";
import { AddInboxRelay, AddOutboxRelay, RemoveInboxRelay, RemoveOutboxRelay } from "applesauce-actions/actions/mailboxes";
import { AddDirectMessageRelay, RemoveDirectMessageRelay } from "applesauce-actions/actions/direct-message-relays";
import { AddBlossomServer, RemoveBlossomServer, SetDefaultBlossomServer } from "applesauce-actions/actions/blossom";
import type { ProfileContent } from "applesauce-core/helpers/profile";
import type { Signer } from "../concord/stream";
import { createSettingsRunner, saveRelayList, userFor } from "./settings-actions";
import { UserAvatar } from "./User";

const LOOKUP_RELAY_LIST_KIND = 10086;

type PageId = "profile" | "dm" | "relays" | "blossom" | "lookup";

const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "profile", label: "Profile", icon: <UserIcon size={18} /> },
  { id: "relays", label: "Relays", icon: <Mailbox size={18} /> },
  { id: "dm", label: "DM Inbox Relays", icon: <Inbox size={18} /> },
  { id: "blossom", label: "Blossom Servers", icon: <Flower2 size={18} /> },
  { id: "lookup", label: "Indexer Relays", icon: <Radar size={18} /> },
];

/** Normalize a user-typed URL, prefixing `scheme://` when none is given. */
function normalizeUrl(input: string, scheme: "wss" | "https"): string | null {
  let url = input.trim();
  if (!url) return null;
  if (!/^[a-z]+:\/\//i.test(url)) url = `${scheme}://${url}`;
  try {
    return new URL(url).toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

export function SettingsView({
  page: pageParam,
  onSelectPage,
  onClose,
}: {
  page: string;
  onSelectPage: (page: PageId) => void;
  onClose: () => void;
}) {
  const account = useActiveAccount();
  // Fall back to the profile page for an unknown/empty `?settings=` value.
  const page: PageId = PAGES.some((p) => p.id === pageParam) ? (pageParam as PageId) : "profile";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!account) return null;
  const signer = account.signer as Signer;
  const pubkey = account.pubkey;

  return (
    <div className="settings">
      <nav className="settings-nav">
        <div className="settings-nav-head">
          <UserAvatar pubkey={pubkey} />
          <span>Settings</span>
        </div>
        {PAGES.map((p) => (
          <button key={p.id} className={`settings-nav-item ${page === p.id ? "active" : ""}`} onClick={() => onSelectPage(p.id)}>
            {p.icon}
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-content">
        <button className="settings-close" title="Close (Esc)" onClick={onClose}>
          <X size={22} />
        </button>
        <div className="settings-page">
          {page === "profile" && <ProfilePage signer={signer} pubkey={pubkey} />}
          {page === "relays" && <MailboxesPage signer={signer} pubkey={pubkey} />}
          {page === "dm" && <DmRelaysPage signer={signer} pubkey={pubkey} />}
          {page === "blossom" && <BlossomPage signer={signer} pubkey={pubkey} />}
          {page === "lookup" && <LookupPage signer={signer} pubkey={pubkey} />}
        </div>
      </div>
    </div>
  );
}

type PageProps = { signer: Signer; pubkey: string };

// ---- Profile (kind 0) ----------------------------------------------------

const PROFILE_FIELDS: { key: keyof ProfileContent; label: string; placeholder: string; type?: string }[] = [
  { key: "name", label: "Username", placeholder: "satoshi" },
  { key: "display_name", label: "Display name", placeholder: "Satoshi Nakamoto" },
  { key: "picture", label: "Avatar URL", placeholder: "https://…/avatar.png", type: "url" },
  { key: "banner", label: "Banner URL", placeholder: "https://…/banner.png", type: "url" },
  { key: "website", label: "Website", placeholder: "https://example.com", type: "url" },
  { key: "nip05", label: "NIP-05 identifier", placeholder: "name@domain.com" },
  { key: "lud16", label: "Lightning address", placeholder: "name@wallet.com" },
];

function ProfilePage({ signer, pubkey }: PageProps) {
  const user = useMemo(() => userFor(pubkey), [pubkey]);
  const runner = useMemo(() => createSettingsRunner(signer, pubkey), [signer, pubkey]);
  const profile = use$(() => user.profile$, [user]);

  const [form, setForm] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the form from the loaded profile once (and whenever a fresh copy loads).
  // Reset during render (keyed on the profile object) rather than in an effect,
  // avoiding a cascading render each time the profile stream emits.
  const [seededFrom, setSeededFrom] = useState<typeof profile | undefined>(undefined);
  if (profile !== seededFrom) {
    setSeededFrom(profile);
    const m = (profile?.metadata ?? {}) as Record<string, unknown>;
    const next: Record<string, string> = {};
    for (const f of PROFILE_FIELDS) next[f.key as string] = (m[f.key as string] as string) ?? "";
    next.about = (m.about as string) ?? "";
    setForm(next);
  }

  function set(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const content: Partial<ProfileContent> = {};
      for (const f of PROFILE_FIELDS) {
        const v = form[f.key as string]?.trim();
        if (v) (content as Record<string, unknown>)[f.key as string] = v;
      }
      const about = form.about?.trim();
      if (about) content.about = about;
      // UpdateProfile merges into an existing kind 0; new users have none yet.
      await runner.run(profile ? UpdateProfile : CreateProfile, content);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Profile</h2>
      <p className="settings-sub">Your public Nostr profile (kind 0). Anyone can see this.</p>
      {form.banner ? (
        <div className="profile-banner" style={{ backgroundImage: `url(${form.banner})` }} />
      ) : (
        <div className="profile-banner empty" />
      )}
      <div className="profile-avatar-preview">
        {form.picture ? <img src={form.picture} alt="" /> : <UserAvatar pubkey={pubkey} />}
      </div>
      {PROFILE_FIELDS.map((f) => (
        <div className="field" key={f.key as string}>
          <label>{f.label}</label>
          <input
            type={f.type ?? "text"}
            value={form[f.key as string] ?? ""}
            placeholder={f.placeholder}
            onChange={(e) => set(f.key as string, e.target.value)}
          />
        </div>
      ))}
      <div className="field">
        <label>About</label>
        <textarea value={form.about ?? ""} rows={4} placeholder="Tell people about yourself" onChange={(e) => set("about", e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="settings-actions">
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </button>
        {saved && <span className="settings-saved">Saved ✓</span>}
      </div>
    </>
  );
}

// ---- Reusable relay/server list editor -----------------------------------

function RelayListEditor({
  items,
  placeholder,
  scheme = "wss",
  onAdd,
  onRemove,
  renderExtra,
}: {
  items: string[];
  placeholder: string;
  scheme?: "wss" | "https";
  onAdd: (url: string) => Promise<void>;
  onRemove: (url: string) => Promise<void>;
  renderExtra?: (url: string, index: number) => ReactNode;
}) {
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    const url = normalizeUrl(input, scheme);
    if (!url) {
      setError("Enter a valid URL");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onAdd(url);
      setInput("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="relay-add">
        <input
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn" onClick={add} disabled={busy || !input.trim()}>
          Add
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {items.length === 0 ? (
        <p className="settings-sub" style={{ marginTop: 12 }}>
          None configured yet.
        </p>
      ) : (
        <ul className="relay-list">
          {items.map((url, i) => (
            <li key={url} className="relay-row">
              <span className="relay-url">{url.replace(/^(wss|https?):\/\//, "")}</span>
              {renderExtra?.(url, i)}
              <button className="icon-btn" title="Remove" onClick={() => onRemove(url)}>
                <Trash2 size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---- NIP-65 mailboxes (kind 10002) ---------------------------------------

function MailboxesPage({ signer, pubkey }: PageProps) {
  const user = useMemo(() => userFor(pubkey), [pubkey]);
  const runner = useMemo(() => createSettingsRunner(signer, pubkey), [signer, pubkey]);
  const inboxes = use$(() => user.inboxes$, [user]) ?? [];
  const outboxes = use$(() => user.outboxes$, [user]) ?? [];

  return (
    <>
      <h2>Relays</h2>
      <p className="settings-sub">
        Your NIP-65 relay list (kind 10002). <strong>Outbox</strong> relays are where you publish; other people read your
        notes there. <strong>Inbox</strong> relays are where others send you replies and mentions.
      </p>
      <h3>Outbox (write)</h3>
      <RelayListEditor
        items={outboxes}
        placeholder="wss://relay.example.com"
        onAdd={(url) => runner.run(AddOutboxRelay, url)}
        onRemove={(url) => runner.run(RemoveOutboxRelay, url)}
      />
      <h3 style={{ marginTop: 28 }}>Inbox (read)</h3>
      <RelayListEditor
        items={inboxes}
        placeholder="wss://relay.example.com"
        onAdd={(url) => runner.run(AddInboxRelay, url)}
        onRemove={(url) => runner.run(RemoveInboxRelay, url)}
      />
    </>
  );
}

// ---- DM inbox relays (kind 10050) ----------------------------------------

function DmRelaysPage({ signer, pubkey }: PageProps) {
  const user = useMemo(() => userFor(pubkey), [pubkey]);
  const runner = useMemo(() => createSettingsRunner(signer, pubkey), [signer, pubkey]);
  const relays = use$(() => user.directMessageRelays$, [user]) ?? [];

  return (
    <>
      <h2>DM Inbox Relays</h2>
      <p className="settings-sub">
        Where you receive NIP-17 encrypted direct messages (kind 10050). Senders publish gift-wraps to these relays, so
        list a couple you check reliably.
      </p>
      <RelayListEditor
        items={relays}
        placeholder="wss://relay.example.com"
        onAdd={(url) => runner.run(AddDirectMessageRelay, url)}
        onRemove={(url) => runner.run(RemoveDirectMessageRelay, url)}
      />
    </>
  );
}

// ---- Blossom servers (kind 10063) ----------------------------------------

function BlossomPage({ signer, pubkey }: PageProps) {
  const user = useMemo(() => userFor(pubkey), [pubkey]);
  const runner = useMemo(() => createSettingsRunner(signer, pubkey), [signer, pubkey]);
  const servers = (use$(() => user.blossomServers$, [user]) ?? []).map((u) => u.toString().replace(/\/$/, ""));

  return (
    <>
      <h2>Blossom Servers</h2>
      <p className="settings-sub">
        Media servers used to host your uploads (kind 10063). The first server is your default — uploads go there first.
      </p>
      <RelayListEditor
        items={servers}
        placeholder="https://blossom.example.com"
        scheme="https"
        onAdd={(url) => runner.run(AddBlossomServer, url)}
        onRemove={(url) => runner.run(RemoveBlossomServer, new URL(url))}
        renderExtra={(url, i) =>
          i === 0 ? (
            <span className="badge role">Default</span>
          ) : (
            <button className="icon-btn" title="Set as default" onClick={() => runner.run(SetDefaultBlossomServer, new URL(url))}>
              <Star size={16} />
            </button>
          )
        }
      />
    </>
  );
}

// ---- Indexer / lookup relays (kind 10086) --------------------------------

function LookupPage({ signer, pubkey }: PageProps) {
  const user = useMemo(() => userFor(pubkey), [pubkey]);
  const list = use$(() => user.lookupRelayList$, [user]);
  const relays = list?.relays ?? [];

  async function replace(next: string[]) {
    await saveRelayList(signer, pubkey, LOOKUP_RELAY_LIST_KIND, next);
  }

  return (
    <>
      <h2>Indexer Relays</h2>
      <p className="settings-sub">
        Lookup / indexer relays (kind 10086) that aggregate profiles and relay lists network-wide. Clients use these to
        discover events for people you have no relay hint for.
      </p>
      <RelayListEditor
        items={relays}
        placeholder="wss://index.example.com"
        onAdd={(url) => replace([...new Set([...relays, url])])}
        onRemove={(url) => replace(relays.filter((r) => r !== url))}
      />
    </>
  );
}
