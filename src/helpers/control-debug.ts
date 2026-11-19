/**
 * Pure helpers for the developer control-plane debugger: entity labels, head
 * lookup, rumor assembly and the publish templates (valid edits built from the
 * current folded state, plus deliberately invalid editions for fold testing).
 */
import { hexToBytes } from "@noble/hashes/utils.js";
import { PERM, VSK } from "@applesauce/concord";
import type { CommunityState, EditionVersion, PermName, Rumor } from "@applesauce/concord";
import {
  banlistLocator,
  computeEditionHash,
  CONTROL_KIND,
  grantLocator,
  hasPerm,
  inviteLinksLocator,
  parsePermissions,
  PAUSE_SIGNAL_ID,
  signalLocator,
} from "@applesauce/concord/helpers";

// ---- labels ----------------------------------------------------------------

const PERM_ENTRIES = Object.entries(PERM) as [PermName, bigint][];

/** The permission-bit names set in a decimal permissions string. */
export function decodePerms(permissions: string): PermName[] {
  let bits: bigint;
  try {
    bits = parsePermissions(permissions);
  } catch {
    return [];
  }
  return PERM_ENTRIES.filter(([, bit]) => hasPerm(bits, bit)).map(([name]) => name);
}

/** Every permission bit, as the decimal string a role carries. */
export const ALL_PERMISSIONS = PERM_ENTRIES.reduce((mask, [, bit]) => mask | bit, 0n).toString();

/** Entity labels by `vsk`. */
export const VSK_LABELS: Record<number, string> = {
  [VSK.METADATA]: "Metadata",
  [VSK.ROLE]: "Role",
  [VSK.CHANNEL]: "Channel",
  [VSK.GRANT]: "Grant",
  [VSK.BANLIST]: "Banlist",
  [VSK.INVITE_REGISTRY]: "Invite registry",
  [VSK.DISSOLVED]: "Dissolved",
  [VSK.PINS]: "Pins",
  [VSK.SIGNALS]: "Signal",
};

export function vskLabel(vsk: string | number | undefined): string {
  const n = Number(vsk);
  return VSK_LABELS[n] ?? `vsk ${vsk ?? "?"}`;
}

export function tagVal(rumor: Pick<Rumor, "tags">, name: string): string | undefined {
  return rumor.tags.find((t) => t[0] === name)?.[1];
}

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

const pretty = (value: unknown) => JSON.stringify(value, null, 2);

// ---- heads -----------------------------------------------------------------

export interface EntityHead {
  version: EditionVersion;
  hash: string;
  prevHash?: string;
  content: string;
  /** `verified` comes from the verification projection; `latest` is the highest `ev` held for the eid. */
  source: "verified" | "latest";
}

/** Debugger fallback for malformed/missing counters; never round a valid large counter. */
export function rumorEditionVersion(rumor: Rumor): bigint {
  const value = tagVal(rumor, "ev") ?? "0";
  return /^[0-9]+$/.test(value) ? BigInt(value) : 0n;
}

export function compareRumorEditions(a: Rumor, b: Rumor): number {
  const left = rumorEditionVersion(a), right = rumorEditionVersion(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** The current head of an entity: the verified head when there is one, else the highest-version edition held. */
export function entityHead(state: CommunityState, rumors: readonly Rumor[], eid: string): EntityHead | undefined {
  const verified = state.controlVerification?.heads.get(eid);
  if (verified) {
    return {
      version: verified.version,
      hash: verified.hash,
      prevHash: verified.prevHash,
      content: verified.edition.rumor.content,
      source: "verified",
    };
  }
  let best: Rumor | undefined;
  for (const r of rumors) {
    if (tagVal(r, "eid") !== eid) continue;
    if (!best || compareRumorEditions(r, best) > 0) best = r;
  }
  if (!best) return undefined;
  const counter = rumorEditionVersion(best);
  const version = counter <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(counter) : counter.toString();
  const prevHash = tagVal(best, "ep");
  let hash = "";
  try {
    hash = computeEditionHash({ vsk: Number(tagVal(best, "vsk")), eid, version, prevHash, content: best.content });
  } catch {
    // A malformed edition has no computable hash; the caller can still fill `ep` by hand.
  }
  return { version, hash, prevHash, content: best.content, source: "latest" };
}

/** The `[grant eid, version, hash]` citation for `self`'s verified Grant; undefined for the owner or without one. */
export function ownVac(state: CommunityState, self: string): [string, string, string] | undefined {
  if (self === state.material.owner) return undefined;
  const eid = grantLocator(hexToBytes(state.material.community_id), self);
  const head = state.controlVerification?.heads.get(eid);
  return head ? [eid, String(head.version), head.hash] : undefined;
}

// ---- drafts ----------------------------------------------------------------

export type PublishPlane = "control" | "guestbook" | "dissolved" | "channel";
export type VacMode = "auto" | "none" | "custom";

export interface EditionFields {
  vsk: number;
  eid: string;
  ev: string;
  ep: string;
  vacMode: VacMode;
  /** Custom citation as `<grant_eid> <version> <hash>`. */
  vac: string;
  content: string;
}

export interface RawFields {
  kind: string;
  tags: string;
  content: string;
}

export interface Envelope {
  plane: PublishPlane;
  channelId: string;
  plaintext: boolean;
  ephemeral: boolean;
}

export type Draft =
  | { mode: "edition"; edition: EditionFields; envelope: Envelope }
  | { mode: "raw"; raw: RawFields; envelope: Envelope };

export const CONTROL_ENVELOPE: Envelope = { plane: "control", channelId: "", plaintext: true, ephemeral: false };

export interface RumorTemplate {
  kind: number;
  content: string;
  tags: string[][];
}

/** Assemble the rumor to publish from edition fields, or throw a readable error. Values are not validated beyond shape. */
export function editionRumor(fields: EditionFields, state: CommunityState, self: string): RumorTemplate {
  const eid = fields.eid.trim();
  if (!eid) throw new Error("eid is required");
  const tags: string[][] = [
    ["vsk", String(fields.vsk)],
    ["eid", eid],
  ];
  if (fields.ev.trim()) tags.push(["ev", fields.ev.trim()]);
  if (fields.ep.trim()) tags.push(["ep", fields.ep.trim()]);
  if (fields.vacMode === "auto") {
    const vac = ownVac(state, self);
    if (vac) tags.push(["vac", ...vac]);
    else if (self !== state.material.owner) throw new Error("No verified Grant to cite: choose None or Custom");
  } else if (fields.vacMode === "custom") {
    const parts = fields.vac.trim().split(/\s+/);
    if (parts.length !== 3) throw new Error("vac needs 3 space-separated parts: <grant_eid> <version> <hash>");
    tags.push(["vac", ...parts]);
  }
  return { kind: CONTROL_KIND, content: fields.content, tags };
}

/** Assemble the rumor from raw fields, or throw. */
export function rawRumor(fields: RawFields): RumorTemplate {
  const kind = Number(fields.kind);
  if (!Number.isInteger(kind)) throw new Error("kind must be an integer");
  let tags: unknown;
  try {
    tags = JSON.parse(fields.tags);
  } catch (e) {
    throw new Error(`tags are not valid JSON: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
  if (!Array.isArray(tags) || !tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string")))
    throw new Error("tags must be an array of string arrays");
  return { kind, content: fields.content, tags: tags as string[][] };
}

export function draftRumor(draft: Draft, state: CommunityState, self: string): RumorTemplate {
  return draft.mode === "edition" ? editionRumor(draft.edition, state, self) : rawRumor(draft.raw);
}

// ---- templates -------------------------------------------------------------

export type TemplateParam = "role" | "channel" | "member";

export interface TemplateContext {
  state: CommunityState;
  rumors: readonly Rumor[];
  self: string;
  /** The selected role id, channel id or member pubkey, for templates with a `param`. */
  target: string;
}

export interface ControlTemplate {
  id: string;
  group: "edit" | "invalid" | "other";
  label: string;
  /** One short line shown under the picker. */
  hint: string;
  param?: TemplateParam;
  build: (ctx: TemplateContext) => Draft;
}

const cidBytes = (ctx: TemplateContext) => hexToBytes(ctx.state.material.community_id);

/** A correctly chained next edition of `eid`. */
function nextEdition(ctx: TemplateContext, vsk: number, eid: string, content: string, patch: Partial<EditionFields> = {}): Draft {
  const head = entityHead(ctx.state, ctx.rumors, eid);
  return {
    mode: "edition",
    edition: {
      vsk,
      eid,
      ev: String(BigInt(head?.version ?? 0) + 1n),
      ep: head?.hash ?? "",
      vacMode: "auto",
      vac: "",
      content,
      ...patch,
    },
    envelope: CONTROL_ENVELOPE,
  };
}

function metadataContent(ctx: TemplateContext) {
  return ctx.state.metadata ?? { name: ctx.state.material.name, relays: ctx.state.material.relays };
}

function role(ctx: TemplateContext) {
  const r = ctx.state.roles.find((x) => x.role_id === ctx.target);
  if (!r) throw new Error("Pick a role");
  return r;
}

function channel(ctx: TemplateContext) {
  const c = ctx.state.channels.find((x) => x.channel_id === ctx.target);
  if (!c) throw new Error("Pick a channel");
  const rest: Record<string, unknown> = { ...c };
  delete rest.channel_id;
  return rest;
}

function member(ctx: TemplateContext) {
  const m = ctx.target.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(m)) throw new Error("Enter a 64-hex member pubkey");
  return m;
}

function newRole(ctx: TemplateContext, eid: string, patch: Record<string, unknown> = {}) {
  const position = Math.max(0, ...ctx.state.roles.flatMap((r) => r.position === undefined ? [] : [r.position])) + 1;
  return pretty({ role_id: eid, name: "Debug role", position, permissions: "0", scope: { kind: "server" }, color: 0, ...patch });
}

const banlistEid = (ctx: TemplateContext) => banlistLocator(cidBytes(ctx));
const pauseEid = (ctx: TemplateContext) => signalLocator(cidBytes(ctx), PAUSE_SIGNAL_ID);

export const CONTROL_TEMPLATES: ControlTemplate[] = [
  // -- valid edits from the current state --
  {
    id: "metadata",
    group: "edit",
    label: "Edit community metadata",
    hint: "Current metadata as the next edition.",
    build: (ctx) => nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty(metadataContent(ctx))),
  },
  {
    id: "role-create",
    group: "edit",
    label: "Create role",
    hint: "New server role below every existing role, no permissions.",
    build: (ctx) => {
      const eid = randomHex(32);
      return nextEdition(ctx, VSK.ROLE, eid, newRole(ctx, eid));
    },
  },
  {
    id: "role-edit",
    group: "edit",
    label: "Edit role",
    hint: "The role's current document as the next edition.",
    param: "role",
    build: (ctx) => nextEdition(ctx, VSK.ROLE, ctx.target, pretty(role(ctx))),
  },
  {
    id: "role-delete",
    group: "edit",
    label: "Delete role",
    hint: "Marks the role deleted with no permissions.",
    param: "role",
    build: (ctx) => nextEdition(ctx, VSK.ROLE, ctx.target, pretty({ ...role(ctx), permissions: "0", deleted: true })),
  },
  {
    id: "channel-create",
    group: "edit",
    label: "Create public channel",
    hint: "New public chat channel.",
    build: (ctx) => nextEdition(ctx, VSK.CHANNEL, randomHex(32), pretty({ name: "debug-channel", private: false })),
  },
  {
    id: "channel-edit",
    group: "edit",
    label: "Edit channel",
    hint: "The channel's current document as the next edition.",
    param: "channel",
    build: (ctx) => nextEdition(ctx, VSK.CHANNEL, ctx.target, pretty(channel(ctx))),
  },
  {
    id: "channel-delete",
    group: "edit",
    label: "Delete channel",
    hint: "Terminal deletion; the id cannot be reused.",
    param: "channel",
    build: (ctx) => nextEdition(ctx, VSK.CHANNEL, ctx.target, pretty({ ...channel(ctx), deleted: true })),
  },
  {
    id: "grant-set",
    group: "edit",
    label: "Set member's roles",
    hint: "The member's current Grant; edit role_ids. Split staff Grants also need control_wrap.",
    param: "member",
    build: (ctx) => {
      const m = member(ctx);
      return nextEdition(ctx, VSK.GRANT, grantLocator(cidBytes(ctx), m), pretty({ member: m, role_ids: ctx.state.grants.get(m) ?? [] }));
    },
  },
  {
    id: "grant-clear",
    group: "edit",
    label: "Strip member's roles",
    hint: "Grant with no roles.",
    param: "member",
    build: (ctx) => {
      const m = member(ctx);
      return nextEdition(ctx, VSK.GRANT, grantLocator(cidBytes(ctx), m), pretty({ member: m, role_ids: [] }));
    },
  },
  {
    id: "ban",
    group: "edit",
    label: "Ban member",
    hint: "Current banlist plus the member. Does not strip roles or refound.",
    param: "member",
    build: (ctx) => nextEdition(ctx, VSK.BANLIST, banlistEid(ctx), pretty([...new Set([...ctx.state.banlist, member(ctx)])])),
  },
  {
    id: "unban",
    group: "edit",
    label: "Unban member",
    hint: "Current banlist without the member.",
    param: "member",
    build: (ctx) => {
      const m = member(ctx);
      return nextEdition(ctx, VSK.BANLIST, banlistEid(ctx), pretty([...ctx.state.banlist].filter((p) => p !== m)));
    },
  },
  {
    id: "pause",
    group: "edit",
    label: "Pause community",
    hint: "Pause signal, ending in one hour.",
    build: (ctx) => nextEdition(ctx, VSK.SIGNALS, pauseEid(ctx), pretty({ paused: true, until: Math.floor(Date.now() / 1000) + 3600 })),
  },
  {
    id: "resume",
    group: "edit",
    label: "Resume community",
    hint: "Lifts the pause signal.",
    build: (ctx) => nextEdition(ctx, VSK.SIGNALS, pauseEid(ctx), pretty({ paused: false })),
  },
  {
    id: "invite-registry",
    group: "edit",
    label: "Edit my invite registry",
    hint: "Your link_signer list; any entry makes the community public.",
    build: (ctx) => {
      const eid = inviteLinksLocator(cidBytes(ctx), ctx.self);
      return nextEdition(ctx, VSK.INVITE_REGISTRY, eid, entityHead(ctx.state, ctx.rumors, eid)?.content ?? "[]");
    },
  },
  {
    id: "dissolve",
    group: "edit",
    label: "Dissolve community",
    hint: "Owner-only tombstone on the dissolved plane. Permanent.",
    build: (ctx) => ({
      mode: "raw",
      raw: { kind: String(CONTROL_KIND), tags: pretty([["vsk", String(VSK.DISSOLVED)], ["eid", ctx.state.material.community_id]]), content: "" },
      envelope: { ...CONTROL_ENVELOPE, plane: "dissolved", plaintext: false },
    }),
  },

  // -- deliberately invalid --
  {
    id: "inv-position-zero",
    group: "invalid",
    label: "Role at position 0",
    hint: "Position 0 is reserved for the owner.",
    build: (ctx) => {
      const eid = randomHex(32);
      return nextEdition(ctx, VSK.ROLE, eid, newRole(ctx, eid, { name: "Usurper", position: 0, permissions: ALL_PERMISSIONS }));
    },
  },
  {
    id: "inv-all-perms",
    group: "invalid",
    label: "Role with every permission",
    hint: "Rejected unless you hold rank and every bit.",
    build: (ctx) => {
      const eid = randomHex(32);
      return nextEdition(ctx, VSK.ROLE, eid, newRole(ctx, eid, { name: "Everything", permissions: ALL_PERMISSIONS }));
    },
  },
  {
    id: "inv-grant-self-all",
    group: "invalid",
    label: "Grant myself every role",
    hint: "Self-escalation through my own Grant.",
    build: (ctx) =>
      nextEdition(
        ctx,
        VSK.GRANT,
        grantLocator(cidBytes(ctx), ctx.self),
        pretty({ member: ctx.self, role_ids: ctx.state.roles.filter((r) => !r.deleted).map((r) => r.role_id) }),
      ),
  },
  {
    id: "inv-grant-unknown-role",
    group: "invalid",
    label: "Grant an unknown role",
    hint: "role_ids cites a role that does not exist.",
    param: "member",
    build: (ctx) => {
      const m = member(ctx);
      return nextEdition(ctx, VSK.GRANT, grantLocator(cidBytes(ctx), m), pretty({ member: m, role_ids: [randomHex(32)] }));
    },
  },
  {
    id: "inv-ban-owner",
    group: "invalid",
    label: "Ban the owner",
    hint: "Banlist naming the owner.",
    build: (ctx) => nextEdition(ctx, VSK.BANLIST, banlistEid(ctx), pretty([...new Set([...ctx.state.banlist, ctx.state.material.owner])])),
  },
  {
    id: "inv-ban-malformed",
    group: "invalid",
    label: "Banlist with a malformed key",
    hint: "One bad entry voids the whole edition.",
    build: (ctx) => nextEdition(ctx, VSK.BANLIST, banlistEid(ctx), pretty([...ctx.state.banlist, "not-a-pubkey"])),
  },
  {
    id: "inv-version-skip",
    group: "invalid",
    label: "Version skip",
    hint: "Metadata at ev = head + 50.",
    build: (ctx) => {
      const draft = nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty({ ...metadataContent(ctx), name: "Skipped" }));
      if (draft.mode === "edition") draft.edition.ev = String(BigInt(draft.edition.ev) + 49n);
      return draft;
    },
  },
  {
    id: "inv-broken-ep",
    group: "invalid",
    label: "Broken ep chain",
    hint: "Next version citing a random previous hash.",
    build: (ctx) =>
      nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty({ ...metadataContent(ctx), name: "Orphan" }), { ep: randomHex(32) }),
  },
  {
    id: "inv-fork",
    group: "invalid",
    label: "Fork the head version",
    hint: "Same ev and ep as the current head, different content.",
    build: (ctx) => {
      const eid = ctx.state.material.community_id;
      const head = entityHead(ctx.state, ctx.rumors, eid);
      return nextEdition(ctx, VSK.METADATA, eid, pretty({ ...metadataContent(ctx), name: "Fork" }), {
        ev: String(head?.version ?? 1),
        ep: head?.prevHash ?? "",
      });
    },
  },
  {
    id: "inv-downgrade",
    group: "invalid",
    label: "Downgrade",
    hint: "Metadata at ev = head − 1.",
    build: (ctx) => {
      const head = entityHead(ctx.state, ctx.rumors, ctx.state.material.community_id);
      return nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty({ ...metadataContent(ctx), name: "Downgrade" }), {
        ev: String(BigInt(head?.version ?? 2) > 1n ? BigInt(head?.version ?? 2) - 1n : 1n),
        ep: "",
      });
    },
  },
  {
    id: "inv-forged-vac",
    group: "invalid",
    label: "Forged vac citation",
    hint: "Metadata edit citing a Grant that does not exist.",
    build: (ctx) =>
      nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty({ ...metadataContent(ctx), name: "Forged" }), {
        vacMode: "custom",
        vac: `${randomHex(32)} 1 ${randomHex(32)}`,
      }),
  },
  {
    id: "inv-wrong-vsk",
    group: "invalid",
    label: "Wrong vsk for the eid",
    hint: "A Role document at the metadata coordinate.",
    build: (ctx) => {
      const eid = ctx.state.material.community_id;
      return nextEdition(ctx, VSK.ROLE, eid, newRole(ctx, eid));
    },
  },
  {
    id: "inv-metadata-eid",
    group: "invalid",
    label: "Metadata at a random eid",
    hint: "Metadata must sit at the community_id.",
    build: (ctx) => nextEdition(ctx, VSK.METADATA, randomHex(32), pretty({ name: "Imposter" })),
  },
  {
    id: "inv-perm-number",
    group: "invalid",
    label: "Permissions as a number",
    hint: "permissions must be a decimal string.",
    build: (ctx) => {
      const eid = randomHex(32);
      return nextEdition(ctx, VSK.ROLE, eid, newRole(ctx, eid, { name: "Bad perms", permissions: 16 }));
    },
  },
  {
    id: "inv-oversized-name",
    group: "invalid",
    label: "Oversized community name",
    hint: "Name over the 64-byte cap.",
    build: (ctx) => nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty({ ...metadataContent(ctx), name: "x".repeat(200) })),
  },
  {
    id: "inv-bad-json",
    group: "invalid",
    label: "Content is not JSON",
    hint: "Metadata edition with unparsable content.",
    build: (ctx) => nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, "{ not json"),
  },
  {
    id: "inv-no-ev",
    group: "invalid",
    label: "Missing ev tag",
    hint: "Metadata edition without a version.",
    build: (ctx) => nextEdition(ctx, VSK.METADATA, ctx.state.material.community_id, pretty(metadataContent(ctx)), { ev: "", ep: "" }),
  },
  {
    id: "inv-pause-long",
    group: "invalid",
    label: "Pause beyond 30 days",
    hint: "until 60 days ahead.",
    build: (ctx) =>
      nextEdition(ctx, VSK.SIGNALS, pauseEid(ctx), pretty({ paused: true, until: Math.floor(Date.now() / 1000) + 60 * 86400 })),
  },

  // -- other --
  {
    id: "blank",
    group: "other",
    label: "Blank edition",
    hint: "Empty edition at a random eid.",
    build: (ctx) => nextEdition(ctx, VSK.CHANNEL, randomHex(32), "{}"),
  },
  {
    id: "raw",
    group: "other",
    label: "Raw rumor",
    hint: "Any kind, tags and content.",
    build: () => ({
      mode: "raw",
      raw: { kind: String(CONTROL_KIND), tags: pretty([["vsk", "2"], ["eid", randomHex(32)], ["ev", "1"]]), content: "{}" },
      envelope: CONTROL_ENVELOPE,
    }),
  },
];

export const TEMPLATE_GROUPS: { id: ControlTemplate["group"]; label: string }[] = [
  { id: "edit", label: "Edit current state" },
  { id: "invalid", label: "Invalid editions" },
  { id: "other", label: "Other" },
];

/** Well-known eids for the picker, labelled. */
export function knownEids(state: CommunityState, self: string): { eid: string; label: string }[] {
  const cid = hexToBytes(state.material.community_id);
  return [
    { eid: state.material.community_id, label: "metadata (community_id)" },
    { eid: banlistLocator(cid), label: "banlist" },
    { eid: signalLocator(cid, PAUSE_SIGNAL_ID), label: "pause signal" },
    { eid: grantLocator(cid, self), label: "my grant" },
    { eid: inviteLinksLocator(cid, self), label: "my invite registry" },
    ...state.roles.map((r) => ({ eid: r.role_id, label: `role ${r.name}` })),
    ...state.channels.map((c) => ({ eid: c.channel_id, label: `channel #${c.name}` })),
  ];
}
