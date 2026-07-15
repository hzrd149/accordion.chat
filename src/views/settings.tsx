import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { FlaskConical, Flower2, Inbox, Mailbox, Monitor, Moon, Radar, Search, Star, Sun, SunMoon, Trash2, User as UserIcon } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { CreateProfile, UpdateProfile } from "applesauce-actions/actions/profile";
import { AddInboxRelay, AddOutboxRelay, RemoveInboxRelay, RemoveOutboxRelay } from "applesauce-actions/actions/mailboxes";
import { AddDirectMessageRelay, RemoveDirectMessageRelay } from "applesauce-actions/actions/direct-message-relays";
import { AddBlossomServer, RemoveBlossomServer, SetDefaultBlossomServer } from "applesauce-actions/actions/blossom";
import type { ProfileContent } from "applesauce-core/helpers/profile";
import type { ISigner } from "applesauce-signers";
import { createSettingsRunner, saveRelayList, userFor } from "../lib/settings-actions";
import { UserAvatar } from "../components/User";
import { useTheme, type ThemePref } from "../lib/theme";
import { useDevMode, setDevMode } from "../lib/dev-mode";
import {
  DEFAULT_OPEN_RANKING_PROVIDER,
  fetchOpenRankingCapabilities,
  useOpenRankingProvider,
} from "../lib/open-ranking";

const LOOKUP_RELAY_LIST_KIND = 10086;

type PageId = "profile" | "appearance" | "dm" | "relays" | "blossom" | "lookup" | "discovery" | "advanced";

const PAGES: { id: PageId; label: string; icon: ReactNode }[] = [
  { id: "profile", label: "Profile", icon: <UserIcon size={18} /> },
  { id: "appearance", label: "Appearance", icon: <SunMoon size={18} /> },
  { id: "relays", label: "Relays", icon: <Mailbox size={18} /> },
  { id: "dm", label: "DM Inbox Relays", icon: <Inbox size={18} /> },
  { id: "blossom", label: "Blossom Servers", icon: <Flower2 size={18} /> },
  { id: "lookup", label: "Indexer Relays", icon: <Radar size={18} /> },
  { id: "discovery", label: "Discovery", icon: <Search size={18} /> },
  { id: "advanced", label: "Advanced", icon: <FlaskConical size={18} /> },
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
  mobileNav,
  onSelectPage,
}: {
  page: string;
  mobileNav: ReactNode;
  onSelectPage: (page: PageId) => void;
}) {
  const account = useActiveAccount();
  // Fall back to the profile page for an unknown/empty page value.
  const page: PageId = PAGES.some((p) => p.id === pageParam) ? (pageParam as PageId) : "profile";

  if (!account) return null;
  const signer = account.signer as ISigner;
  const pubkey = account.pubkey;

  return (
    <div className="flex-1 flex min-w-0 bg-base-100 max-md:flex-col">
      <nav className="w-58 shrink-0 bg-base-200 p-3 overflow-y-auto flex flex-col gap-0.5 max-md:w-full max-md:flex-row max-md:items-center max-md:gap-1 max-md:overflow-x-auto max-md:overflow-y-hidden max-md:border-b max-md:border-base-300">
        {mobileNav}
        <div className="flex items-center gap-2.5 px-2 pt-1.5 pb-3 text-[11px] uppercase font-bold tracking-wide text-base-content/60 max-md:p-0 max-md:pr-1 max-md:shrink-0">
          <UserAvatar pubkey={pubkey} className="w-7 h-7" />
          <span className="max-md:hidden">Settings</span>
        </div>
        {PAGES.map((p) => (
          <button
            key={p.id}
            className={`btn btn-ghost justify-start gap-2.5 w-full font-medium max-md:w-auto max-md:shrink-0 ${page === p.id ? "btn-active" : ""}`}
            onClick={() => onSelectPage(p.id)}
          >
            {p.icon}
            <span>{p.label}</span>
          </button>
        ))}
      </nav>
      <div className="flex-1 relative overflow-y-auto p-10 max-md:px-4 max-md:py-6">
        <div className="max-w-[640px]">
          {page === "profile" && <ProfilePage signer={signer} pubkey={pubkey} />}
          {page === "appearance" && <AppearancePage />}
          {page === "relays" && <MailboxesPage signer={signer} pubkey={pubkey} />}
          {page === "dm" && <DmRelaysPage signer={signer} pubkey={pubkey} />}
          {page === "blossom" && <BlossomPage signer={signer} pubkey={pubkey} />}
          {page === "lookup" && <LookupPage signer={signer} pubkey={pubkey} />}
          {page === "discovery" && <DiscoveryPage />}
          {page === "advanced" && <AdvancedPage />}
        </div>
      </div>
    </div>
  );
}

type PageProps = { signer: ISigner; pubkey: string };

// ---- Appearance ----------------------------------------------------------

const THEME_OPTIONS: { value: ThemePref; label: string; hint: string; icon: ReactNode }[] = [
  { value: "system", label: "System", hint: "Match your device settings", icon: <Monitor size={18} /> },
  { value: "light", label: "Light", hint: "Always use the light theme", icon: <Sun size={18} /> },
  { value: "dark", label: "Dark", hint: "Always use the dark theme", icon: <Moon size={18} /> },
];

function AppearancePage() {
  const { pref, resolved, setTheme } = useTheme();
  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Appearance</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Choose how Accordion looks. <strong>System</strong> follows your operating system's
        light/dark setting — currently <strong>{resolved}</strong>.
      </p>
      <div className="flex flex-col gap-2.5 max-w-[420px]">
        {THEME_OPTIONS.map((o) => {
          const active = pref === o.value;
          return (
            <label
              key={o.value}
              className={`flex items-center gap-3 p-3.5 rounded-lg border cursor-pointer transition-colors ${
                active ? "border-primary bg-primary/10" : "border-base-300 bg-base-200 hover:bg-base-300"
              }`}
            >
              <input
                type="radio"
                name="theme"
                className="radio radio-primary radio-sm"
                value={o.value}
                checked={active}
                onChange={() => setTheme(o.value)}
              />
              <span className={`flex ${active ? "text-primary" : "text-base-content/60"}`}>{o.icon}</span>
              <span className="flex flex-col gap-px">
                <span className="font-semibold">{o.label}</span>
                <span className="text-xs opacity-60">{o.hint}</span>
              </span>
            </label>
          );
        })}
      </div>
    </>
  );
}

// ---- Discovery ------------------------------------------------------------

function DiscoveryPage() {
  const { provider, setProvider, resetProvider } = useOpenRankingProvider();
  const [value, setValue] = useState(provider);
  const [seededProvider, setSeededProvider] = useState(provider);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (provider !== seededProvider) {
    setSeededProvider(provider);
    setValue(provider);
  }

  async function save(test: boolean) {
    setBusy(true);
    setStatus(null);
    setError(null);
    try {
      const next = setProvider(value);
      setValue(next);
      if (test) {
        const caps = await fetchOpenRankingCapabilities(next);
        const search = caps["/search/pubkeys"];
        if (!search?.length) throw new Error("Provider does not advertise /search/pubkeys");
        setStatus(`Provider ready: ${search[0].name || search[0].id}`);
      } else {
        setStatus("Saved");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save provider");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    resetProvider();
    setValue(DEFAULT_OPEN_RANKING_PROVIDER);
    setStatus("Reset to default provider");
    setError(null);
  }

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Discovery</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Direct invite global search uses an Open Ranking provider. This stays local to this browser.
      </p>
      {error && <div className="alert alert-error text-sm mb-4">{error}</div>}
      {status && <div className="alert alert-success text-sm mb-4">{status}</div>}
      <label className="label text-xs font-semibold uppercase opacity-70" htmlFor="open-ranking-provider">
        Open Ranking provider
      </label>
      <input
        id="open-ranking-provider"
        className="input input-bordered w-full max-w-[520px]"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setStatus(null);
          setError(null);
        }}
        placeholder={DEFAULT_OPEN_RANKING_PROVIDER}
      />
      <p className="text-xs opacity-60 mt-2 max-w-[520px]">
        The default is Brainstorm staging. The provider must support <code>/search/pubkeys</code>.
      </p>
      <div className="flex gap-2 mt-4 flex-wrap">
        <button className="btn btn-primary" disabled={busy} onClick={() => void save(false)}>
          {busy ? "Saving…" : "Save"}
        </button>
        <button className="btn" disabled={busy} onClick={() => void save(true)}>
          Test provider
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={reset}>
          Reset default
        </button>
      </div>
    </>
  );
}

// ---- Advanced ------------------------------------------------------------

function AdvancedPage() {
  const devMode = useDevMode();
  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Advanced</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Low-level options for power users. Most people won't need anything here.
      </p>

      <h3 className="text-lg font-bold mb-1">Developer mode</h3>
      <p className="text-sm opacity-70 leading-relaxed mb-4 max-w-[440px]">
        Adds a <strong>Developer tools</strong> button to the sidebar with low-level protocol utilities, like walking a
        community's cryptographic history epoch by epoch.
      </p>
      <label className="flex items-center gap-3 p-3.5 rounded-lg border border-base-300 bg-base-200 cursor-pointer max-w-[440px]">
        <input
          type="checkbox"
          className="toggle toggle-primary"
          checked={devMode}
          onChange={(e) => setDevMode(e.target.checked)}
        />
        <span className="flex flex-col gap-px">
          <span className="font-semibold">Enable developer mode</span>
          <span className="text-xs opacity-60">Show the /dev tools in the sidebar</span>
        </span>
      </label>
    </>
  );
}

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
      <h2 className="text-2xl font-bold mb-1">Profile</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">Your public Nostr profile (kind 0). Anyone can see this.</p>
      {form.banner ? (
        <div className="h-30 rounded-lg bg-base-200 bg-cover bg-center" style={{ backgroundImage: `url(${form.banner})` }} />
      ) : (
        <div className="h-30 rounded-lg bg-base-200 border border-dashed border-base-300" />
      )}
      <div className="-mt-11 mb-4 ml-4">
        {form.picture ? (
          <img className="w-20 h-20 rounded-full object-cover border-[6px] border-base-100 bg-base-200" src={form.picture} alt="" />
        ) : (
          <UserAvatar pubkey={pubkey} className="w-20 h-20 border-[6px] border-base-100" />
        )}
      </div>
      {PROFILE_FIELDS.map((f) => (
        <div className="mb-4" key={f.key as string}>
          <label className="label text-xs font-semibold uppercase opacity-70">{f.label}</label>
          <input
            className="input input-bordered w-full"
            type={f.type ?? "text"}
            value={form[f.key as string] ?? ""}
            placeholder={f.placeholder}
            onChange={(e) => set(f.key as string, e.target.value)}
          />
        </div>
      ))}
      <div className="mb-4">
        <label className="label text-xs font-semibold uppercase opacity-70">About</label>
        <textarea className="textarea textarea-bordered w-full" value={form.about ?? ""} rows={4} placeholder="Tell people about yourself" onChange={(e) => set("about", e.target.value)} />
      </div>
      {error && <div className="alert alert-error text-sm mb-3">{error}</div>}
      <div className="flex items-center gap-3.5 mt-5">
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? "Saving…" : "Save profile"}
        </button>
        {saved && <span className="text-success text-sm font-semibold">Saved ✓</span>}
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
      <div className="flex gap-2.5 max-sm:flex-col">
        <input
          className="input input-bordered flex-1"
          value={input}
          placeholder={placeholder}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button className="btn btn-primary max-sm:self-end" onClick={add} disabled={busy || !input.trim()}>
          Add
        </button>
      </div>
      {error && <div className="alert alert-error text-sm mt-3">{error}</div>}
      {items.length === 0 ? (
        <p className="text-sm opacity-70 leading-relaxed mt-3">None configured yet.</p>
      ) : (
        <ul className="mt-3.5 flex flex-col gap-1">
          {items.map((url, i) => (
            <li key={url} className="flex items-center gap-2.5 px-3 py-2 bg-base-200 rounded-md min-w-0">
              <span className="flex-1 font-mono text-[13px] overflow-hidden text-ellipsis whitespace-nowrap">{url.replace(/^(wss|https?):\/\//, "")}</span>
              {renderExtra?.(url, i)}
              <button className="btn btn-ghost btn-sm btn-circle hover:text-error" title="Remove" onClick={() => onRemove(url)}>
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
      <h2 className="text-2xl font-bold mb-1">Relays</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Your NIP-65 relay list (kind 10002). <strong>Outbox</strong> relays are where you publish; other people read your
        notes there. <strong>Inbox</strong> relays are where others send you replies and mentions.
      </p>
      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-2">Outbox (write)</h3>
      <RelayListEditor
        items={outboxes}
        placeholder="wss://relay.example.com"
        onAdd={(url) => runner.run(AddOutboxRelay, url)}
        onRemove={(url) => runner.run(RemoveOutboxRelay, url)}
      />
      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-7 mb-2">Inbox (read)</h3>
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
      <h2 className="text-2xl font-bold mb-1">DM Inbox Relays</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
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
      <h2 className="text-2xl font-bold mb-1">Blossom Servers</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
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
            <span className="badge badge-primary badge-sm">Default</span>
          ) : (
            <button className="btn btn-ghost btn-sm btn-circle" title="Set as default" onClick={() => runner.run(SetDefaultBlossomServer, new URL(url))}>
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
      <h2 className="text-2xl font-bold mb-1">Indexer Relays</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
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
