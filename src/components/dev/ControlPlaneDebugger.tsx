/**
 * Control Plane Debugger — a developer tool to inspect a community's control
 * plane (CORD-02/03/04) and hand-craft + publish arbitrary control events to it,
 * bypassing the user's role/permission checks. Concord enforces authority
 * fold-side, not relay-side: `ConcordCommunity.publishToPlane` wraps and ships any
 * rumor with no permission gate, so this tool can inject deliberately invalid
 * editions (wrong version, no authority, broken chain, …) and observe how the
 * fold and peers react. Editions are echoed into the local `controlStore`/`state$`
 * immediately, so the State + Log panels below update live after a publish.
 *
 * FOR TESTING ONLY — every publish hits the community's real relays and cannot be
 * unsent.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Landmark, RefreshCw } from "lucide-react";
import { use$, useActiveAccount } from "applesauce-react/hooks";
import { VSK, PERM } from "applesauce-concord";
import type { CommunityState, ConcordCommunity, PermName, Rumor } from "applesauce-concord";
import { CONTROL_KIND, parsePermissions, hasPerm } from "applesauce-concord/helpers";
import { useConcord } from "../../lib/concord-context";
import { useCommunity } from "../../hooks/use-community";
import { ConfirmModal } from "../modals";
import { formatTime } from "../../lib/util";

// ---- small helpers ---------------------------------------------------------

const PERM_ENTRIES = Object.entries(PERM) as [PermName, bigint][];

/** The permission-bit names set in a decimal permissions string. */
function decodePerms(permissions: string): PermName[] {
  let bits: bigint;
  try {
    bits = parsePermissions(permissions);
  } catch {
    return [];
  }
  return PERM_ENTRIES.filter(([, bit]) => hasPerm(bits, bit)).map(([name]) => name);
}

/** Map a `vsk` value to its entity label. */
const VSK_LABELS: Record<number, string> = {
  [VSK.METADATA]: "Metadata",
  [VSK.ROLE]: "Role",
  [VSK.CHANNEL]: "Channel",
  [VSK.GRANT]: "Grant",
  [VSK.BANLIST]: "Banlist",
  [VSK.INVITE_REGISTRY]: "Invite registry",
  [VSK.DISSOLVED]: "Dissolved",
};

function vskLabel(vsk: string | number | undefined): string {
  const n = Number(vsk);
  return VSK_LABELS[n] ?? `vsk ${vsk ?? "?"}`;
}

function shortHex(hex: string | undefined): string {
  if (!hex) return "—";
  return hex.length > 18 ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : hex;
}

function tagVal(rumor: Rumor, name: string): string | undefined {
  return rumor.tags.find((t) => t[0] === name)?.[1];
}

/** JSON.stringify that survives bigint (control perms) and Map/Set (state). */
function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_k, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Map) return Object.fromEntries(v);
      if (v instanceof Set) return [...v];
      return v;
    },
    2,
  );
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- current state panel ---------------------------------------------------

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-base-300 rounded-box p-4 flex flex-col gap-2">
      <h3 className="font-bold uppercase tracking-wide opacity-70">{title}</h3>
      {children}
    </div>
  );
}

function StatePanel({ state }: { state: CommunityState }) {
  return (
    <div className="flex flex-col gap-3">
      <Section title="Community">
        <div className="flex flex-col gap-1">
          <div>
            <span className="opacity-60">name </span>
            <strong>{state.metadata?.name ?? state.material.name}</strong>
          </div>
          {state.metadata?.description && <div className="opacity-80">{state.metadata.description}</div>}
          <div className="flex flex-wrap gap-2 mt-1">
            <span className="badge badge-outline">{state.members.size} members</span>
            <span className="badge badge-outline">{state.roles.length} roles</span>
            <span className="badge badge-outline">{state.channels.length} channels</span>
            <span className="badge badge-outline">{state.banlist.size} banned</span>
            {state.dissolved && <span className="badge badge-error">dissolved</span>}
          </div>
          <code className="opacity-50 break-all mt-1">{state.material.community_id}</code>
        </div>
      </Section>

      <Section title="Roles">
        {state.roles.length === 0 ? (
          <p className="opacity-60">No roles.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {[...state.roles]
              .sort((a, b) => a.position - b.position)
              .map((r) => (
                <div key={r.role_id} className="flex items-baseline gap-2 flex-wrap ">
                  <span className="badge badge-sm" style={r.color ? { backgroundColor: `#${r.color.toString(16).padStart(6, "0")}`, color: "#fff", borderColor: "transparent" } : undefined}>
                    {r.name}
                  </span>
                  <span className="opacity-50">pos {r.position}</span>
                  <span className="opacity-50">{r.scope.kind === "channel" ? `#${shortHex(r.scope.channel_id)}` : "server"}</span>
                  <span className="opacity-70">{decodePerms(r.permissions).join(", ") || "no perms"}</span>
                  <code className="opacity-40">{shortHex(r.role_id)}</code>
                </div>
              ))}
          </div>
        )}
      </Section>

      <Section title="Channels">
        {state.channels.length === 0 ? (
          <p className="opacity-60">No channels.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {state.channels.map((c) => (
              <div key={c.channel_id} className="flex items-baseline gap-2 ">
                <span>#{c.name}</span>
                <span className={`badge badge-xs ${c.private ? "badge-secondary" : "badge-ghost"}`}>{c.private ? "private" : "public"}</span>
                {c.voice && <span className="badge badge-xs badge-info">voice</span>}
                {c.deleted && <span className="badge badge-xs badge-error">deleted</span>}
                <code className="opacity-40">{shortHex(c.channel_id)}</code>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Grants">
        {state.grants.size === 0 ? (
          <p className="opacity-60">No grants.</p>
        ) : (
          <div className="flex flex-col gap-1">
            {[...state.grants].map(([member, roleIds]) => (
              <div key={member} className="flex items-baseline gap-2 ">
                <code className="opacity-60">{shortHex(member)}</code>
                <span className="opacity-80">
                  {roleIds.map((id) => state.roles.find((r) => r.role_id === id)?.name ?? shortHex(id)).join(", ")}
                </span>
              </div>
            ))}
          </div>
        )}
      </Section>

      {state.banlist.size > 0 && (
        <Section title="Banlist">
          <div className="flex flex-col gap-1">
            {[...state.banlist].map((p) => (
              <code key={p} className="opacity-70">{shortHex(p)}</code>
            ))}
          </div>
        </Section>
      )}

      <details className="border border-base-300 rounded-box p-3">
        <summary className="cursor-pointer font-medium opacity-70">Raw folded state (JSON)</summary>
        <pre className="mt-2 max-h-[50vh] overflow-auto rounded-box bg-base-300 p-3 font-mono whitespace-pre select-text">
          {stringify(state)}
        </pre>
      </details>
    </div>
  );
}

// ---- control log panel -----------------------------------------------------

type EntityChain = { key: string; vsk: string; eid: string; editions: Rumor[] };

/** Group the raw control rumors into per-entity edition chains, ordered by `ev`. */
function groupChains(rumors: Rumor[]): EntityChain[] {
  const map = new Map<string, EntityChain>();
  for (const r of rumors) {
    const vsk = tagVal(r, "vsk") ?? "?";
    const eid = tagVal(r, "eid") ?? "?";
    const key = `${vsk}:${eid}`;
    if (!map.has(key)) map.set(key, { key, vsk, eid, editions: [] });
    map.get(key)!.editions.push(r);
  }
  for (const chain of map.values()) {
    chain.editions.sort((a, b) => Number(tagVal(a, "ev") ?? 0) - Number(tagVal(b, "ev") ?? 0));
  }
  return [...map.values()].sort((a, b) => Number(a.vsk) - Number(b.vsk) || a.eid.localeCompare(b.eid));
}

function EditionRow({ rumor, isHead }: { rumor: Rumor; isHead: boolean }) {
  const [open, setOpen] = useState(false);
  const ev = tagVal(rumor, "ev");
  const ep = tagVal(rumor, "ep");
  const vac = rumor.tags.find((t) => t[0] === "vac");
  return (
    <div className="border-t border-base-300 first:border-t-0 py-1.5">
      <button className="w-full flex items-center gap-2 text-left " onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? "" : "-rotate-90"}`} />
        <span className="badge badge-xs badge-outline shrink-0">v{ev ?? "?"}</span>
        {isHead ? (
          <span className="badge badge-xs badge-success shrink-0">applied</span>
        ) : (
          <span className="badge badge-xs badge-ghost shrink-0" title="Not the winning edition for this entity — superseded or rejected by the fold">not applied</span>
        )}
        <code className="opacity-60 shrink-0">{shortHex(rumor.pubkey)}</code>
        <span className="opacity-40 truncate flex-1">{rumor.content || "(empty)"}</span>
        <span className="opacity-40 shrink-0 max-sm:hidden">{formatTime(rumor.created_at * 1000)}</span>
      </button>
      {open && (
        <div className="pl-6 pt-1 flex flex-col gap-1">
          {ep && <div className="opacity-60">ep {shortHex(ep)}</div>}
          {vac && <div className="opacity-60">vac [{vac.slice(1).map(shortHex).join(", ")}]</div>}
          <pre className="max-h-[40vh] overflow-auto rounded-box bg-base-300 p-3 font-mono whitespace-pre select-text">
            {stringify(rumor)}
          </pre>
        </div>
      )}
    </div>
  );
}

function LogPanel({ rumors, state }: { rumors: Rumor[]; state: CommunityState }) {
  const chains = useMemo(() => groupChains(rumors), [rumors]);
  const headIds = useMemo(() => {
    const s = new Set<string>();
    state.heads?.forEach((d) => s.add(d.rumor.id));
    return s;
  }, [state.heads]);

  if (chains.length === 0) return <p className="opacity-60">No control-plane editions loaded yet.</p>;

  return (
    <div className="flex flex-col gap-3">
      <p className="opacity-60">
        {rumors.length} editions across {chains.length} entities. <span className="badge badge-xs badge-success">applied</span> = the winning
        head for its entity; <span className="badge badge-xs badge-ghost">not applied</span> = superseded or rejected by the fold.
      </p>
      {chains.map((chain) => (
        <div key={chain.key} className="border border-base-300 rounded-box p-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="badge badge-sm badge-primary">{vskLabel(chain.vsk)}</span>
            <code className="opacity-60">{shortHex(chain.eid)}</code>
            <span className="opacity-40">{chain.editions.length} editions</span>
          </div>
          {chain.editions.map((r) => (
            <EditionRow key={r.id} rumor={r} isHead={headIds.has(r.id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

// ---- event builder / publisher --------------------------------------------

type Plane = "control" | "guestbook" | "dissolved" | "channel";
type Mode = "guided" | "raw";

const VSK_TEMPLATES: { vsk: number; content: (ctx: { eid: string; self: string }) => string }[] = [
  { vsk: VSK.METADATA, content: () => stringify({ name: "Debug name", description: "Set from the debugger" }) },
  {
    vsk: VSK.ROLE,
    content: ({ eid }) => stringify({ role_id: eid, name: "Debug role", position: 1, permissions: "0", scope: { kind: "server" }, color: 0 }),
  },
  { vsk: VSK.CHANNEL, content: () => stringify({ name: "debug-channel", private: false }) },
  { vsk: VSK.GRANT, content: ({ self }) => stringify({ member: self, role_ids: [] }) },
  { vsk: VSK.BANLIST, content: () => stringify([]) },
  { vsk: VSK.INVITE_REGISTRY, content: () => stringify([]) },
  { vsk: VSK.DISSOLVED, content: () => '""' },
];

/** Deliberately-invalid presets (CORD-04 §3) to observe fold-side rejection. */
const PRESETS: { label: string; vsk: number; content: string; ev?: string; ep?: string }[] = [
  { label: "Role claiming position 0 (owner-only)", vsk: VSK.ROLE, content: stringify({ name: "Usurper", position: 0, permissions: "16", scope: { kind: "server" }, color: 0 }) },
  { label: "Role with BAN perm, no authority", vsk: VSK.ROLE, content: stringify({ name: "Ban squad", position: 1, permissions: "16", scope: { kind: "server" }, color: 0 }) },
  { label: "Version skip (ev = 99)", vsk: VSK.CHANNEL, content: stringify({ name: "skipped", private: false }), ev: "99" },
  { label: "Broken ep chain (bogus prev hash)", vsk: VSK.CHANNEL, content: stringify({ name: "orphan", private: false }), ev: "2", ep: randomHex(32) },
  { label: "permissions as a bare number (not string)", vsk: VSK.ROLE, content: '{\n  "name": "Bad perms",\n  "position": 1,\n  "permissions": 16,\n  "scope": { "kind": "server" }\n}' },
  { label: "Oversized name (> 64 bytes)", vsk: VSK.METADATA, content: stringify({ name: "x".repeat(200) }) },
];

function BuilderPanel({ community, state, self, rumors }: { community: ConcordCommunity; state: CommunityState; self: string; rumors: Rumor[] }) {
  const [mode, setMode] = useState<Mode>("guided");

  // guided fields
  const [vsk, setVsk] = useState<number>(VSK.ROLE);
  const [eid, setEid] = useState(() => randomHex(32));
  const [ev, setEv] = useState("1");
  const [ep, setEp] = useState("");
  const [vac, setVac] = useState("");
  const guidedTemplate = (v: number, id: string) => (VSK_TEMPLATES.find((t) => t.vsk === v)?.content ?? (() => ""))({ eid: id, self });
  const [content, setContent] = useState(() => guidedTemplate(VSK.ROLE, eid));

  // raw fields
  const [rawKind, setRawKind] = useState(String(CONTROL_KIND));
  const [rawTags, setRawTags] = useState('[\n  ["vsk", "2"],\n  ["eid", ""],\n  ["ev", "1"]\n]');
  const [rawContent, setRawContent] = useState("");

  // shared target
  const [plane, setPlane] = useState<Plane>("control");
  const [channelId, setChannelId] = useState("");
  const [plaintext, setPlaintext] = useState(true);
  const [ephemeral, setEphemeral] = useState(false);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  function applyVsk(v: number) {
    setVsk(v);
    setContent(guidedTemplate(v, eid));
    setPlane(v === VSK.DISSOLVED ? "dissolved" : "control");
    setPlaintext(v !== VSK.DISSOLVED);
    setResult(null);
  }

  function applyPreset(p: (typeof PRESETS)[number]) {
    setMode("guided");
    setVsk(p.vsk);
    setContent(p.content);
    setEv(p.ev ?? "1");
    setEp(p.ep ?? "");
    setPlane("control");
    setPlaintext(true);
    setResult(null);
    setBuildError(null);
  }

  /** Fill `ev` with latest-version-for-this-eid + 1 from the loaded log. */
  function autoVersion() {
    const versions = rumors
      .filter((r) => tagVal(r, "eid") === eid)
      .map((r) => Number(tagVal(r, "ev") ?? 0));
    setEv(String((versions.length ? Math.max(...versions) : 0) + 1));
  }

  /** Assemble the rumor to publish, or throw a build error. */
  function buildRumor(): { kind: number; content: string; tags: string[][] } {
    if (mode === "raw") {
      const kind = Number(rawKind);
      if (!Number.isFinite(kind)) throw new Error("kind must be a number");
      let tags: unknown;
      try {
        tags = JSON.parse(rawTags);
      } catch (e) {
        throw new Error(`tags is not valid JSON: ${e instanceof Error ? e.message : e}`, { cause: e });
      }
      if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string")))
        throw new Error("tags must be an array of string arrays");
      return { kind, content: rawContent, tags: tags as string[][] };
    }
    if (!eid.trim()) throw new Error("eid is required");
    const tags: string[][] = [
      ["vsk", String(vsk)],
      ["eid", eid.trim()],
      ["ev", ev.trim() || "1"],
    ];
    if (ep.trim()) tags.push(["ep", ep.trim()]);
    if (vac.trim()) {
      const parts = vac.trim().split(/\s+/);
      if (parts.length !== 3) throw new Error("vac must be 3 space-separated parts: <grant_eid> <version> <edition_hash>");
      tags.push(["vac", ...parts]);
    }
    return { kind: CONTROL_KIND, content, tags };
  }

  function openConfirm() {
    setResult(null);
    setBuildError(null);
    try {
      buildRumor();
      setConfirmOpen(true);
    } catch (e) {
      setBuildError(e instanceof Error ? e.message : String(e));
    }
  }

  async function publish() {
    const rumor = buildRumor();
    const target = plane === "channel" ? ({ plane, channelId: channelId.trim() } as const) : ({ plane } as const);
    const id = await community.publishToPlane(target, rumor, { plaintext, ephemeral });
    setResult(id);
  }

  const previewRumor = (() => {
    try {
      return stringify(buildRumor());
    } catch (e) {
      return `⚠ ${e instanceof Error ? e.message : e}`;
    }
  })();

  return (
    <div className="flex flex-col gap-4">
      <div className="alert alert-warning py-2 ">
        <AlertTriangle size={18} />
        <span>Publishes to <strong>{state.metadata?.name ?? state.material.name}</strong>'s real relays with no permission check. It can't be unsent.</span>
      </div>

      <div className="tabs tabs-boxed w-fit">
        <button className={`tab ${mode === "guided" ? "tab-active" : ""}`} onClick={() => setMode("guided")}>Guided</button>
        <button className={`tab ${mode === "raw" ? "tab-active" : ""}`} onClick={() => setMode("raw")}>Raw</button>
      </div>

      {mode === "guided" ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-3 items-end">
            <label className="flex flex-col gap-1">
              <span className="font-semibold uppercase opacity-70">Entity (vsk)</span>
              <select className="select select-bordered " value={vsk} onChange={(e) => applyVsk(Number(e.target.value))}>
                {Object.entries(VSK_LABELS).map(([v, label]) => (
                  <option key={v} value={v}>{label} ({v})</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-64">
              <span className="font-semibold uppercase opacity-70">eid (entity id)</span>
              <div className="flex gap-1">
                <input className="input input-bordered flex-1 font-mono " value={eid} onChange={(e) => setEid(e.target.value)} list="dbg-eids" />
                <button className="btn " title="Random 32 bytes" onClick={() => setEid(randomHex(32))}>rand</button>
              </div>
              <datalist id="dbg-eids">
                <option value={state.material.community_id}>community_id (metadata eid)</option>
                {state.roles.map((r) => <option key={r.role_id} value={r.role_id}>role {r.name}</option>)}
                {state.channels.map((c) => <option key={c.channel_id} value={c.channel_id}>channel #{c.name}</option>)}
              </datalist>
            </label>
          </div>

          <div className="flex flex-wrap gap-3 items-end">
            <label className="flex flex-col gap-1 w-28">
              <span className="font-semibold uppercase opacity-70">ev</span>
              <div className="flex gap-1">
                <input className="input input-bordered w-16" value={ev} onChange={(e) => setEv(e.target.value)} />
                <button className="btn " title="latest + 1" onClick={autoVersion}>auto</button>
              </div>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-48">
              <span className="font-semibold uppercase opacity-70">ep (prev hash, optional)</span>
              <input className="input input-bordered font-mono " value={ep} onChange={(e) => setEp(e.target.value)} placeholder="omit for v1" />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-semibold uppercase opacity-70">vac (optional: grant_eid version hash)</span>
            <input className="input input-bordered font-mono " value={vac} onChange={(e) => setVac(e.target.value)} placeholder="omit when acting as owner" />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-semibold uppercase opacity-70">content (JSON string)</span>
            <textarea className="textarea textarea-bordered font-mono h-40" value={content} onChange={(e) => setContent(e.target.value)} />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-semibold uppercase opacity-70">Load an invalid preset</span>
            <select
              className="select select-bordered "
              value=""
              onChange={(e) => {
                const p = PRESETS[Number(e.target.value)];
                if (p) applyPreset(p);
              }}
            >
              <option value="" disabled>Choose a deliberately-invalid example…</option>
              {PRESETS.map((p, i) => <option key={p.label} value={i}>{p.label}</option>)}
            </select>
          </label>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 w-40">
            <span className="font-semibold uppercase opacity-70">kind</span>
            <input className="input input-bordered " value={rawKind} onChange={(e) => setRawKind(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold uppercase opacity-70">tags (JSON array of string arrays)</span>
            <textarea className="textarea textarea-bordered font-mono h-32" value={rawTags} onChange={(e) => setRawTags(e.target.value)} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-semibold uppercase opacity-70">content (raw string)</span>
            <textarea className="textarea textarea-bordered font-mono h-32" value={rawContent} onChange={(e) => setRawContent(e.target.value)} />
          </label>
        </div>
      )}

      {/* shared target row */}
      <div className="flex flex-wrap gap-3 items-end border-t border-base-300 pt-3">
        <label className="flex flex-col gap-1">
          <span className="font-semibold uppercase opacity-70">Plane</span>
          <select className="select select-bordered " value={plane} onChange={(e) => setPlane(e.target.value as Plane)}>
            <option value="control">control</option>
            <option value="guestbook">guestbook</option>
            <option value="dissolved">dissolved</option>
            <option value="channel">channel</option>
          </select>
        </label>
        {plane === "channel" && (
          <label className="flex flex-col gap-1 flex-1 min-w-48">
            <span className="font-semibold uppercase opacity-70">channelId</span>
            <input className="input input-bordered font-mono " value={channelId} onChange={(e) => setChannelId(e.target.value)} />
          </label>
        )}
        <label className="flex items-center gap-2 cursor-pointer h-8">
          <input type="checkbox" className="checkbox " checked={plaintext} onChange={(e) => setPlaintext(e.target.checked)} />
          plaintext seal
        </label>
        <label className="flex items-center gap-2 cursor-pointer h-8">
          <input type="checkbox" className="checkbox " checked={ephemeral} onChange={(e) => setEphemeral(e.target.checked)} />
          ephemeral
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <span className="font-semibold uppercase opacity-70">Rumor preview</span>
        <pre className="max-h-56 overflow-auto rounded-box bg-base-300 p-3 font-mono whitespace-pre select-text">{previewRumor}</pre>
      </div>

      {buildError && <div className="alert alert-error py-2 ">{buildError}</div>}
      {result && <div className="alert alert-success py-2 ">Published. rumor id <code className="">{shortHex(result)}</code></div>}

      <div>
        <button className="btn btn-error" onClick={openConfirm}>Publish to {plane} plane…</button>
      </div>

      {confirmOpen && (
        <ConfirmModal
          title="Publish control event?"
          body={`This wraps and ships the rumor to ${state.metadata?.name ?? state.material.name}'s relays as you, with no permission check. It cannot be unsent.`}
          confirmLabel="Publish"
          danger
          onConfirm={publish}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

// ---- shell -----------------------------------------------------------------

type Tab = "state" | "log" | "publish";

function Debugger({ cid }: { cid: string }) {
  const community = useCommunity(cid);
  const account = useActiveAccount();
  const state = use$(() => community?.state$, [community]) as CommunityState | undefined;
  const rumors = (use$(() => community?.controlStore.timeline([{ kinds: [CONTROL_KIND] }]), [community]) as Rumor[] | undefined) ?? [];
  const [tab, setTab] = useState<Tab>("state");

  if (!community || !state || !account) return <p className="opacity-70">Loading community…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="tabs tabs-boxed w-fit">
        <button className={`tab ${tab === "state" ? "tab-active" : ""}`} onClick={() => setTab("state")}>State</button>
        <button className={`tab ${tab === "log" ? "tab-active" : ""}`} onClick={() => setTab("log")}>Log ({rumors.length})</button>
        <button className={`tab ${tab === "publish" ? "tab-active" : ""}`} onClick={() => setTab("publish")}>Publish</button>
      </div>
      {tab === "state" && <StatePanel state={state} />}
      {tab === "log" && <LogPanel rumors={rumors} state={state} />}
      {tab === "publish" && <BuilderPanel community={community} state={state} self={account.pubkey} rumors={rumors} />}
    </div>
  );
}

export function ControlPlaneDebugger() {
  const client = useConcord();
  const communities = use$(client.communities$) ?? [];
  const [cid, setCid] = useState<string | null>(null);

  return (
    <>
      <h1 className="text-2xl font-bold mb-1">Control Plane Debugger</h1>
      <p className="opacity-70 leading-relaxed mb-5">
        Inspect a community's control plane and publish hand-crafted control events to it — bypassing your role, so you can
        test how groups react to invalid editions.
      </p>

      <div className="mb-5">
        <label className="font-semibold uppercase opacity-70">Community</label>
        <div className="flex items-center gap-2 mt-1">
          <select
            className="select select-bordered min-w-64"
            value={cid ?? ""}
            onChange={(e) => setCid(e.target.value || null)}
          >
            <option value="" disabled>Select a community…</option>
            {communities.map((c) => (
              <option key={c.material.community_id} value={c.material.community_id}>
                {c.metadata?.name ?? c.material.name ?? "Community"}
              </option>
            ))}
          </select>
          {cid && (
            <button className="btn btn-ghost gap-1" onClick={() => setCid(null)} title="Pick another community">
              <RefreshCw size={14} /> change
            </button>
          )}
        </div>
      </div>

      {cid ? (
        <Debugger key={cid} cid={cid} />
      ) : communities.length === 0 ? (
        <div className="flex flex-col items-center gap-2 opacity-60 py-16 text-center">
          <Landmark size={40} />
          <p>Join or create a community to inspect its control plane.</p>
        </div>
      ) : (
        <p className="opacity-60">Pick a community above to begin.</p>
      )}
    </>
  );
}
