import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { use$ } from "applesauce-react/hooks";
import { isSafeRelayURL, normalizeRelayUrl } from "applesauce-core/helpers/relays";
import { ensureHttpURL, ensureWebSocketURL } from "applesauce-core/helpers/url";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { PERM } from "@applesauce/concord";
import { STOCK_RELAYS } from "@applesauce/concord/helpers";
import { useCommunity } from "../hooks/use-community";
import { pool } from "../nostr";
import { dedupeServers, DEFAULT_BLOSSOM_SERVERS } from "../helpers/blossom";
import { toastError, toastSuccess } from "../services/toasts";

/** CORD-02 §6: readers use only the first 5 distinct relays of a community's list. */
const MAX_RELAYS = 5;
const NO_URLS: string[] = [];

/** Parse a typed relay address into a normalized `wss://` URL, or explain why not. */
function parseRelay(input: string): { url: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Enter a relay address" };
  try {
    const url = normalizeRelayUrl(ensureWebSocketURL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `wss://${trimmed}`));
    if (!isSafeRelayURL(url)) return { error: "Not a valid relay address" };
    return { url };
  } catch {
    return { error: "Not a valid relay address" };
  }
}

/** Parse a typed media server address into a normalized `https://` URL, or explain why not. */
function parseServer(input: string): { url: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "Enter a server address" };
  try {
    const url = new URL(ensureHttpURL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`));
    if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Use an https:// address" };
    return { url: url.toString() };
  } catch {
    return { error: "Not a valid server address" };
  }
}

/** Normalize a relay URL for comparison, keeping malformed values as-is. */
function relayKey(url: string): string {
  try {
    return normalizeRelayUrl(url);
  } catch {
    return url;
  }
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Community network settings: the relay set every plane publishes to and reads
 * from, and the Blossom servers encrypted community media is uploaded to. Both
 * live in the community metadata (CORD-02 §6), so editing requires MANAGE_METADATA;
 * everyone else sees the lists read-only.
 */
export function CommunityNetworkPage({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const metadata = use$(community?.metadata$);
  const dissolved = use$(community?.dissolved$) ?? false;
  const canEdit = (use$(() => community?.can$(PERM.MANAGE_METADATA), [community]) ?? false) && !dissolved;

  // The relays this device dials for the community (join-time material), and the
  // list the metadata fold currently names. They diverge after a relay edit until
  // this device's material follows the fold.
  const materialRelays = community?.material.relays ?? NO_URLS;
  const activeRelays = materialRelays.length ? materialRelays : STOCK_RELAYS;
  const publishedRelays = metadata?.relays?.length ? metadata.relays : materialRelays;
  const publishedServers = metadata?.blossom_servers ?? NO_URLS;

  // Drafts are null until the user edits, so later metadata editions keep showing through.
  const [relayDraft, setRelayDraft] = useState<string[] | null>(null);
  const [serverDraft, setServerDraft] = useState<string[] | null>(null);
  const relays = relayDraft ?? publishedRelays;
  const servers = serverDraft ?? publishedServers;
  const dirty = (relayDraft !== null && !sameList(relayDraft, publishedRelays)) ||
    (serverDraft !== null && !sameList(serverDraft, publishedServers));
  const [busy, setBusy] = useState(false);

  const activeSet = useMemo(() => new Set(activeRelays.map(relayKey)), [activeRelays]);
  const inUseDiffers = useMemo(() => {
    const listed = new Set(publishedRelays.map(relayKey));
    return listed.size > 0 && (listed.size !== activeSet.size || [...listed].some((r) => !activeSet.has(r)));
  }, [activeSet, publishedRelays]);

  async function save() {
    if (!community) return;
    if (relays.length === 0) {
      toastError(new Error("A community needs at least one relay"), "Can't save network settings");
      return;
    }
    setBusy(true);
    try {
      await community.admin.editMetadata({
        ...(relayDraft !== null ? { relays: relayDraft } : {}),
        ...(serverDraft !== null ? { blossom_servers: dedupeServers(serverDraft) } : {}),
      });
      setRelayDraft(null);
      setServerDraft(null);
      toastSuccess("Network settings saved");
    } catch (e) {
      toastError(e, "Failed to save network settings");
    } finally {
      setBusy(false);
    }
  }

  if (!community) return null;

  return (
    <>
      <h2 className="text-2xl font-bold mb-1">Network</h2>
      <p className="text-sm opacity-70 leading-relaxed mb-5">
        Where this community's encrypted messages and media are stored. Every member reads and writes through these servers.
        {!canEdit && !dissolved && " You need the Manage Community permission to change them."}
      </p>

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-6 mb-1">Relays</h3>
      <p className="text-sm opacity-70 leading-relaxed mb-3">
        Members publish and sync every message, role and channel through these relays. Use stable relays that serve
        gift wraps by author; up to {MAX_RELAYS} are used, in order.
      </p>
      <UrlList
        urls={relays}
        editable={canEdit}
        limit={MAX_RELAYS}
        empty="No relays listed — members fall back to the default relays."
        renderRow={(url) => <RelayRow url={url} active={activeSet.has(relayKey(url))} />}
        onChange={setRelayDraft}
      />
      {canEdit && (
        <AddUrl
          placeholder="wss://relay.example.com"
          parse={parseRelay}
          existing={relays}
          onAdd={(url) => setRelayDraft([...relays, url])}
        />
      )}
      {relays.length > MAX_RELAYS && (
        <div className="alert alert-warning text-sm mt-3" role="status">
          Only the first {MAX_RELAYS} relays are used. Remove or reorder the rest.
        </div>
      )}
      {inUseDiffers && relayDraft === null && (
        <div className="alert text-sm mt-3" role="status">
          <div>
            <p className="font-semibold">This device is still connected through the relays it joined with</p>
            <p className="font-mono text-xs opacity-70 break-all">{activeRelays.join(", ")}</p>
          </div>
        </div>
      )}

      <h3 className="text-sm uppercase tracking-wide opacity-70 font-semibold mt-8 mb-1">Media servers</h3>
      <p className="text-sm opacity-70 leading-relaxed mb-3">
        Blossom servers that store the community's encrypted images and attachments. Files are encrypted before
        upload, so servers never see their contents. With none listed, members upload to their own media servers.
      </p>
      <UrlList
        urls={servers}
        editable={canEdit}
        empty={`None listed — members use their own servers, or ${DEFAULT_BLOSSOM_SERVERS.map((s) => new URL(s).host).join(" and ")}.`}
        renderRow={(url) => <ServerRow url={url} />}
        onChange={setServerDraft}
      />
      {canEdit && (
        <AddUrl
          placeholder="https://blossom.example.com"
          parse={parseServer}
          existing={servers}
          onAdd={(url) => setServerDraft([...servers, url])}
        />
      )}

      {canEdit && (
        <div className="flex items-center gap-3.5 mt-6">
          <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save changes"}
          </button>
          {dirty && (
            <button className="btn btn-ghost" disabled={busy} onClick={() => { setRelayDraft(null); setServerDraft(null); }}>
              Reset
            </button>
          )}
        </div>
      )}
    </>
  );
}

function UrlList({
  urls,
  editable,
  limit,
  empty,
  renderRow,
  onChange,
}: {
  urls: string[];
  editable: boolean;
  limit?: number;
  empty: string;
  renderRow: (url: string) => ReactNode;
  onChange: (next: string[]) => void;
}) {
  if (urls.length === 0) {
    return <p className="text-sm opacity-60 rounded-box bg-base-200 border border-base-300 p-3">{empty}</p>;
  }
  const move = (from: number, to: number) => {
    const next = [...urls];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  return (
    <ul className="flex flex-col gap-2">
      {urls.map((url, i) => (
        <li
          key={url}
          className={`flex items-center gap-2 rounded-box bg-base-200 border border-base-300 px-3 py-2 min-w-0 ${limit !== undefined && i >= limit ? "opacity-50" : ""}`}
        >
          <div className="flex-1 min-w-0">{renderRow(url)}</div>
          {editable && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button className="btn btn-ghost btn-xs btn-square" title="Move up" disabled={i === 0} onClick={() => move(i, i - 1)}>
                <ArrowUp size={14} />
              </button>
              <button className="btn btn-ghost btn-xs btn-square" title="Move down" disabled={i === urls.length - 1} onClick={() => move(i, i + 1)}>
                <ArrowDown size={14} />
              </button>
              <button className="btn btn-ghost btn-xs btn-square text-error" title="Remove" onClick={() => onChange(urls.filter((u) => u !== url))}>
                <Trash2 size={14} />
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function AddUrl({
  placeholder,
  parse,
  existing,
  onAdd,
}: {
  placeholder: string;
  parse: (input: string) => { url: string } | { error: string };
  existing: string[];
  onAdd: (url: string) => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  function add() {
    const result = parse(value);
    if ("error" in result) return setError(result.error);
    if (existing.some((u) => u.replace(/\/+$/, "").toLowerCase() === result.url.replace(/\/+$/, "").toLowerCase())) return setError("Already in the list");
    onAdd(result.url);
    setValue("");
    setError(null);
  }

  return (
    <div className="mt-2">
      <div className="join w-full">
        <input
          className={`input input-bordered join-item flex-1 font-mono text-sm ${error ? "input-error" : ""}`}
          value={value}
          placeholder={placeholder}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
        />
        <button className="btn join-item gap-1.5" onClick={add} disabled={!value.trim()}>
          <Plus size={16} />
          Add
        </button>
      </div>
      {error && <p className="text-xs text-error mt-1">{error}</p>}
    </div>
  );
}

function RelayRow({ url, active }: { url: string; active: boolean }) {
  const relay = useMemo(() => pool.relay(url), [url]);
  const information = use$(relay.information$);
  const icon = use$(relay.icon$);
  const connected = use$(relay.connected$) ?? false;
  const name = information?.name || url.replace(/^wss?:\/\//, "").replace(/\/$/, "");
  return (
    <div className="flex items-center gap-2 min-w-0">
      {icon ? <img className="w-6 h-6 rounded-full shrink-0" src={icon} alt="" /> : <div className="w-6 h-6 rounded-full bg-base-300 shrink-0" />}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-sm truncate">{name}</div>
        <div className="font-mono text-[11px] opacity-60 truncate">{url}</div>
      </div>
      {active ? (
        <span className={`badge badge-sm shrink-0 ${connected ? "badge-success" : "badge-ghost"}`}>{connected ? "Connected" : "Offline"}</span>
      ) : (
        <span className="badge badge-sm badge-ghost shrink-0" title="Listed in the community, but this device doesn't use it yet">Not in use</span>
      )}
    </div>
  );
}

function ServerRow({ url }: { url: string }) {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // Keep the raw value for a malformed entry published by another client.
  }
  return (
    <div className="min-w-0">
      <div className="font-medium text-sm truncate">{host}</div>
      <div className="font-mono text-[11px] opacity-60 truncate">{url}</div>
    </div>
  );
}
