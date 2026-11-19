/**
 * Control-plane publisher for the developer debugger: pick a template (valid
 * edits prefilled from the folded state, or deliberately invalid editions),
 * adjust the edition, and publish it with `publishToPlane`, which applies no
 * permission check. Publishes hit the community's real relays.
 */
import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { AlertTriangle, Dices, Send, Wand2 } from "lucide-react";
import type { CommunityState, ConcordCommunity, Rumor } from "@applesauce/concord";
import { ConfirmModal } from "../modals";
import { UserLabel } from "../User";
import { stringify } from "../../helpers/concord-history";
import { compareRoles, roleRank } from "../../helpers/roles";
import {
  CONTROL_TEMPLATES,
  draftRumor,
  editionRumor,
  entityHead,
  knownEids,
  ownVac,
  randomHex,
  TEMPLATE_GROUPS,
  VSK_LABELS,
  type ControlTemplate,
  type Draft,
  type EditionFields,
  type Envelope,
  type PublishPlane,
  type RawFields,
} from "../../helpers/control-debug";
import { DebugSection as Section, DebugTabs, Hex, JsonBlock } from "./debug-ui";

function Field({ label, children, className = "" }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-1 min-w-0 ${className}`}>
      <span className="text-sm font-semibold opacity-70">{label}</span>
      {children}
    </label>
  );
}

function defaultTarget(t: ControlTemplate, state: CommunityState, self: string): string {
  if (t.param === "role") return state.roles.find((r) => !r.deleted)?.role_id ?? "";
  if (t.param === "channel") return state.channels[0]?.channel_id ?? "";
  if (t.param === "member") return [...state.members].find((m) => m !== self) ?? self;
  return "";
}

/** JSON validity of edition content, shown beside the editor. */
function jsonStatus(content: string): "valid" | "invalid" | "empty" {
  if (!content.trim()) return "empty";
  try {
    JSON.parse(content);
    return "valid";
  } catch {
    return "invalid";
  }
}

export function ControlPublisher({
  community,
  state,
  self,
  rumors,
  onShowEditions,
}: {
  community: ConcordCommunity;
  state: CommunityState;
  self: string;
  rumors: Rumor[];
  onShowEditions: (eid: string) => void;
}) {
  const [templateId, setTemplateId] = useState("metadata");
  const template = CONTROL_TEMPLATES.find((t) => t.id === templateId)!;
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState<Draft>(() => template.build({ state, rumors, self, target: "" }));
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<{ id: string; eid?: string } | null>(null);

  function apply(t: ControlTemplate, tgt: string) {
    setResult(null);
    try {
      setDraft(t.build({ state, rumors, self, target: tgt }));
      setTemplateError(null);
    } catch (e) {
      setTemplateError(e instanceof Error ? e.message : String(e));
    }
  }

  function chooseTemplate(id: string) {
    const t = CONTROL_TEMPLATES.find((x) => x.id === id)!;
    const tgt = defaultTarget(t, state, self);
    setTemplateId(id);
    setTarget(tgt);
    apply(t, tgt);
  }

  function chooseTarget(tgt: string) {
    setTarget(tgt);
    apply(template, tgt);
  }

  const setEdition = (patch: Partial<EditionFields>) =>
    setDraft((d) => (d.mode === "edition" ? { ...d, edition: { ...d.edition, ...patch } } : d));
  const setRaw = (patch: Partial<RawFields>) => setDraft((d) => (d.mode === "raw" ? { ...d, raw: { ...d.raw, ...patch } } : d));
  const setEnvelope = (patch: Partial<Envelope>) => setDraft((d) => ({ ...d, envelope: { ...d.envelope, ...patch } }));

  /** Switch between edition fields and a raw rumor, carrying the current rumor across when possible. */
  function setMode(mode: Draft["mode"]) {
    if (mode === draft.mode) return;
    if (mode === "raw" && draft.mode === "edition") {
      let raw: RawFields;
      try {
        const r = editionRumor(draft.edition, state, self);
        raw = { kind: String(r.kind), tags: stringify(r.tags), content: r.content };
      } catch {
        raw = { kind: "3308", tags: "[]", content: draft.edition.content };
      }
      setDraft({ mode: "raw", raw, envelope: draft.envelope });
    } else {
      const fallback = CONTROL_TEMPLATES.find((t) => t.id === "blank")!.build({ state, rumors, self, target: "" });
      setDraft({ ...fallback, envelope: draft.envelope });
    }
  }

  const preview = useMemo(() => {
    try {
      return { rumor: draftRumor(draft, state, self), error: null };
    } catch (e) {
      return { rumor: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [draft, state, self]);

  async function publish() {
    if (!preview.rumor) return;
    const { plane, channelId, plaintext, ephemeral } = draft.envelope;
    const t = plane === "channel" ? ({ plane, channelId: channelId.trim() } as const) : ({ plane } as const);
    const id = await community.publishToPlane(t, preview.rumor, { plaintext, ephemeral });
    setResult({ id, eid: preview.rumor.tags.find((x) => x[0] === "eid")?.[1] });
  }

  const name = state.metadata?.name ?? state.material.name;
  const grouped = TEMPLATE_GROUPS.map((g) => ({ ...g, templates: CONTROL_TEMPLATES.filter((t) => t.group === g.id) }));

  return (
    <div className="flex flex-col gap-6">
      <div className="alert alert-warning py-2">
        <AlertTriangle size={18} />
        <span>Publishes to live relays without permission checks. Irreversible.</span>
      </div>

      <Section title="Template">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Start from" className="flex-1 min-w-64">
            <select className="select select-bordered w-full" value={templateId} onChange={(e) => chooseTemplate(e.target.value)}>
              {grouped.map((g) => (
                <optgroup key={g.id} label={g.label}>
                  {g.templates.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                </optgroup>
              ))}
            </select>
          </Field>
          {template.param && <TargetPicker param={template.param} state={state} value={target} onChange={chooseTarget} />}
          <button className="btn gap-1.5" title="Rebuild from current state" onClick={() => apply(template, target)}>
            <Wand2 size={16} /> Reset
          </button>
        </div>
        <p className={templateError ? "text-error" : "opacity-60"}>{templateError ?? template.hint}</p>
      </Section>

      <Section title="Rumor">
        <DebugTabs
          tabs={[{ id: "edition", label: "Edition fields" }, { id: "raw", label: "Raw" }] as const}
          value={draft.mode}
          onChange={setMode}
          size="sm"
        />
        {draft.mode === "edition" ? (
          <EditionForm fields={draft.edition} state={state} rumors={rumors} self={self} onChange={setEdition} />
        ) : (
          <RawForm fields={draft.raw} onChange={setRaw} />
        )}
      </Section>

      <Section title="Envelope" summary={`${draft.envelope.plane} plane · ${draft.envelope.plaintext ? "plaintext" : "encrypted"} seal${draft.envelope.ephemeral ? " · ephemeral" : ""}`}>
        <div className="flex flex-wrap items-end gap-4">
          <Field label="Plane">
            <select className="select select-bordered select-sm" value={draft.envelope.plane} onChange={(e) => setEnvelope({ plane: e.target.value as PublishPlane })}>
              <option value="control">control</option>
              <option value="guestbook">guestbook</option>
              <option value="dissolved">dissolved</option>
              <option value="channel">channel</option>
            </select>
          </Field>
          {draft.envelope.plane === "channel" && (
            <Field label="Channel" className="min-w-56">
              <select className="select select-bordered select-sm" value={draft.envelope.channelId} onChange={(e) => setEnvelope({ channelId: e.target.value })}>
                <option value="" disabled>Pick a channel…</option>
                {state.channels.map((c) => <option key={c.channel_id} value={c.channel_id}>#{c.name}</option>)}
              </select>
            </Field>
          )}
          <label className="flex items-center gap-2 cursor-pointer h-8">
            <input type="checkbox" className="checkbox checkbox-sm" checked={draft.envelope.plaintext} onChange={(e) => setEnvelope({ plaintext: e.target.checked })} />
            plaintext seal
          </label>
          <label className="flex items-center gap-2 cursor-pointer h-8">
            <input type="checkbox" className="checkbox checkbox-sm" checked={draft.envelope.ephemeral} onChange={(e) => setEnvelope({ ephemeral: e.target.checked })} />
            ephemeral
          </label>
        </div>
      </Section>

      <Section title="Preview">
        {preview.error ? (
          <div className="alert alert-error py-2">{preview.error}</div>
        ) : (
          <JsonBlock json={stringify(preview.rumor)} maxHeight="max-h-64" />
        )}
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn btn-error gap-1.5" disabled={!preview.rumor || (draft.envelope.plane === "channel" && !draft.envelope.channelId)} onClick={() => setConfirmOpen(true)}>
            <Send size={16} /> Publish to {draft.envelope.plane}
          </button>
          {result && (
            <span className="inline-flex flex-wrap items-center gap-2 text-success">
              Published <Hex value={result.id} />
              {result.eid && (
                <button className="btn btn-ghost btn-sm" onClick={() => onShowEditions(result.eid!)}>
                  Show in Editions
                </button>
              )}
            </span>
          )}
        </div>
      </Section>

      {confirmOpen && (
        <ConfirmModal
          title="Publish control event?"
          body={`Publish to ${name}'s ${draft.envelope.plane} plane as you? This cannot be undone.`}
          confirmLabel="Publish"
          danger
          onConfirm={publish}
          onClose={() => setConfirmOpen(false)}
        />
      )}
    </div>
  );
}

function TargetPicker({ param, state, value, onChange }: { param: NonNullable<ControlTemplate["param"]>; state: CommunityState; value: string; onChange: (v: string) => void }) {
  if (param === "role") {
    return (
      <Field label="Role" className="min-w-48">
        <select className="select select-bordered" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>Pick a role…</option>
          {[...state.roles].sort(compareRoles).map((r) => (
            <option key={r.role_id} value={r.role_id}>{r.name} ({r.rank === undefined ? "pos" : "rank"} {roleRank(r)}){r.deleted ? " · deleted" : ""}</option>
          ))}
        </select>
      </Field>
    );
  }
  if (param === "channel") {
    return (
      <Field label="Channel" className="min-w-48">
        <select className="select select-bordered" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>Pick a channel…</option>
          {state.channels.map((c) => <option key={c.channel_id} value={c.channel_id}>#{c.name}</option>)}
        </select>
      </Field>
    );
  }
  return (
    <Field label={<span className="inline-flex items-center gap-2">Member {/^[0-9a-f]{64}$/.test(value) && <UserLabel pubkey={value} />}</span>} className="flex-1 min-w-64">
      <input className="input input-bordered font-mono" list="dbg-members" value={value} placeholder="64-hex pubkey" onChange={(e) => onChange(e.target.value)} />
      <datalist id="dbg-members">
        {[...state.members].map((m) => <option key={m} value={m} />)}
      </datalist>
    </Field>
  );
}

function EditionForm({
  fields,
  state,
  rumors,
  self,
  onChange,
}: {
  fields: EditionFields;
  state: CommunityState;
  rumors: Rumor[];
  self: string;
  onChange: (patch: Partial<EditionFields>) => void;
}) {
  const head = useMemo(() => entityHead(state, rumors, fields.eid.trim()), [state, rumors, fields.eid]);
  const eids = useMemo(() => knownEids(state, self), [state, self]);
  const known = eids.find((k) => k.eid === fields.eid.trim());
  const isOwner = self === state.material.owner;
  const vac = ownVac(state, self);
  const json = jsonStatus(fields.content);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Entity (vsk)">
          <select className="select select-bordered" value={fields.vsk} onChange={(e) => onChange({ vsk: Number(e.target.value) })}>
            {Object.entries(VSK_LABELS).map(([v, label]) => <option key={v} value={v}>{label} ({v})</option>)}
          </select>
        </Field>
        <Field label={<>eid {known && <span className="badge badge-ghost badge-sm ml-1 font-normal">{known.label}</span>}</>} className="flex-1 min-w-64">
          <div className="join w-full">
            <input className="input input-bordered join-item flex-1 font-mono" list="dbg-eids" value={fields.eid} onChange={(e) => onChange({ eid: e.target.value })} />
            <button className="btn join-item" title="Random eid" onClick={() => onChange({ eid: randomHex(32) })}><Dices size={16} /></button>
          </div>
          <datalist id="dbg-eids">
            {eids.map((k) => <option key={k.eid} value={k.eid}>{k.label}</option>)}
          </datalist>
        </Field>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="ev">
          <input className="input input-bordered w-24 font-mono" value={fields.ev} onChange={(e) => onChange({ ev: e.target.value })} />
        </Field>
        <Field label="ep" className="flex-1 min-w-64">
          <input className="input input-bordered font-mono" value={fields.ep} placeholder="none (first edition)" onChange={(e) => onChange({ ep: e.target.value })} />
        </Field>
        <button
          className="btn"
          title="ev = head + 1, ep = head hash"
          onClick={() => onChange({ ev: String(head ? head.version + 1 : 1), ep: head?.hash ?? "" })}
        >
          Next after head
        </button>
      </div>
      <p className="text-sm opacity-60 -mt-2">
        {head ? (
          <>
            Head v{head.version} ({head.source}) <Hex value={head.hash || undefined} />
          </>
        ) : (
          "No editions for this eid."
        )}
      </p>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Authority (vac)">
          <select className="select select-bordered" value={fields.vacMode} onChange={(e) => onChange({ vacMode: e.target.value as EditionFields["vacMode"] })}>
            <option value="auto">{isOwner ? "Auto: owner, no vac" : vac ? `Auto: my Grant v${vac[1]}` : "Auto: no Grant held"}</option>
            <option value="none">None</option>
            <option value="custom">Custom</option>
          </select>
        </Field>
        {fields.vacMode === "custom" && (
          <Field label="grant_eid version hash" className="flex-1 min-w-64">
            <input className="input input-bordered font-mono" value={fields.vac} onChange={(e) => onChange({ vac: e.target.value })} />
          </Field>
        )}
      </div>

      <Field
        label={
          <span className="inline-flex items-center gap-2">
            Content
            {json === "valid" && <span className="badge badge-success badge-sm font-normal">valid JSON</span>}
            {json === "invalid" && <span className="badge badge-warning badge-sm font-normal">not JSON</span>}
          </span>
        }
      >
        <textarea className="textarea textarea-bordered font-mono h-48 w-full" spellCheck={false} value={fields.content} onChange={(e) => onChange({ content: e.target.value })} />
      </Field>
      <div className="flex gap-2 -mt-2">
        <button className="btn btn-sm btn-ghost" disabled={json !== "valid"} onClick={() => onChange({ content: JSON.stringify(JSON.parse(fields.content), null, 2) })}>Format</button>
        <button className="btn btn-sm btn-ghost" disabled={json !== "valid"} onClick={() => onChange({ content: JSON.stringify(JSON.parse(fields.content)) })}>Compact</button>
        <span className="text-sm opacity-50 self-center">Hashed verbatim: whitespace changes the edition hash.</span>
      </div>
    </div>
  );
}

function RawForm({ fields, onChange }: { fields: RawFields; onChange: (patch: Partial<RawFields>) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <Field label="kind" className="w-32">
        <input className="input input-bordered font-mono" value={fields.kind} onChange={(e) => onChange({ kind: e.target.value })} />
      </Field>
      <Field label="tags (JSON array of string arrays)">
        <textarea className="textarea textarea-bordered font-mono h-36 w-full" spellCheck={false} value={fields.tags} onChange={(e) => onChange({ tags: e.target.value })} />
      </Field>
      <Field label="content">
        <textarea className="textarea textarea-bordered font-mono h-36 w-full" spellCheck={false} value={fields.content} onChange={(e) => onChange({ content: e.target.value })} />
      </Field>
    </div>
  );
}
