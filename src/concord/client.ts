// ConcordClient — the reactive engine.
//
// Uses applesauce (EventStore + RelayPool) for all Nostr I/O, and the Concord
// protocol layer (crypto/stream/control/guestbook/invite) to fold plane events
// into reactive community state. One instance per logged-in user.

import { BehaviorSubject, firstValueFrom, timeout, toArray } from "rxjs";
import type { Subscription } from "rxjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";

import { eventStore, pool } from "../nostr";
import { fromHex, toHex, ZERO_32 } from "../lib/bytes";
import {
  banlistLocator,
  dissolvedGroupKey,
  grantLocator,
  inviteLinksLocator,
} from "./crypto";
import { createStreamEvent, decodeStreamEvent } from "./stream";
import type { Signer } from "./stream";
import { foldControl } from "./control";
import { foldMembers } from "./guestbook";
import { resolveStanding, canActOn } from "./permissions";
import type { Standing } from "./permissions";
import { createCommunity, deriveKeys, verifyOwner } from "./community";
import type { CommunityKeys } from "./community";
import { buildEdition, computeEditionHash } from "./editions";
import {
  messageRumor,
  reactionRumor,
  deleteRumor,
  editRumor,
  typingRumor,
  checkChatBinding,
} from "./chat";
import {
  buildBundleEventTemplate,
  buildInviteLink,
  decryptBundle,
  newInviteToken,
  parseInviteLink,
  STOCK_RELAYS,
} from "./invite";
import type { GroupKey } from "./crypto";
import {
  KIND,
  PERM,
  VSK,
  type ChannelMetadata,
  type CommunityMetadata,
  type CommunityState,
  type DecodedEvent,
  type InviteBundle,
  type JoinMaterial,
  type Role,
} from "./types";

const DEFAULT_RELAYS = STOCK_RELAYS;
const TYPING_TTL = 6000;

export interface ChatMessage {
  id: string;
  author: string;
  content: string;
  ms: number;
  edited?: string;
  deleted: boolean;
  replyTo?: { id: string; author: string };
  reactions: { emoji: string; count: number; authors: string[] }[];
}

interface PlaneInfo {
  type: "control" | "guestbook" | "channel" | "dissolved";
  convKey: Uint8Array;
  channelId?: string;
  epoch?: number;
}

interface Runtime {
  material: JoinMaterial;
  keys: CommunityKeys;
  controlEvents: Map<string, DecodedEvent>;
  guestbookEvents: Map<string, DecodedEvent>;
  channelEvents: Map<string, Map<string, DecodedEvent>>;
  observed: Map<string, number>;
  planeMap: Map<string, PlaneInfo>;
  dissolved: boolean;
  sub?: Subscription;
  state$: BehaviorSubject<CommunityState>;
  messages$: Map<string, BehaviorSubject<ChatMessage[]>>;
  typing: Map<string, Map<string, number>>;
  typing$: Map<string, BehaviorSubject<string[]>>;
  refoldTimer?: ReturnType<typeof setTimeout>;
}

function emptyState(material: JoinMaterial): CommunityState {
  return {
    material,
    channels: [],
    roles: [],
    grants: new Map(),
    banlist: new Set(),
    members: new Set(),
    dissolved: false,
  };
}

export class ConcordClient {
  readonly signer: Signer;
  readonly pubkey: string;
  readonly communities$ = new BehaviorSubject<CommunityState[]>([]);
  readonly status$ = new BehaviorSubject<string>("");
  private runtimes = new Map<string, Runtime>();

  constructor(signer: Signer, pubkey: string) {
    this.signer = signer;
    this.pubkey = pubkey;
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    await this.loadCommunityList();
  }

  stop(): void {
    for (const rt of this.runtimes.values()) rt.sub?.unsubscribe();
    this.runtimes.clear();
    this.communities$.next([]);
  }

  getState$(cid: string): BehaviorSubject<CommunityState> | undefined {
    return this.runtimes.get(cid)?.state$;
  }

  getMessages$(cid: string, channelId: string): BehaviorSubject<ChatMessage[]> {
    const rt = this.runtimes.get(cid)!;
    let subj = rt.messages$.get(channelId);
    if (!subj) {
      subj = new BehaviorSubject<ChatMessage[]>([]);
      rt.messages$.set(channelId, subj);
      this.recomputeMessages(rt, channelId);
    }
    return subj;
  }

  getTyping$(cid: string, channelId: string): BehaviorSubject<string[]> {
    const rt = this.runtimes.get(cid)!;
    let subj = rt.typing$.get(channelId);
    if (!subj) {
      subj = new BehaviorSubject<string[]>([]);
      rt.typing$.set(channelId, subj);
    }
    return subj;
  }

  // ---- creating / joining -------------------------------------------------

  async createNewCommunity(name: string, description: string, relays: string[]): Promise<string> {
    const genesis = createCommunity({
      ownerPubkey: this.pubkey,
      name,
      description,
      relays: relays.length ? relays : DEFAULT_RELAYS,
    });
    const rt = this.addRuntime(genesis.material);
    // Publish genesis control editions (plaintext seal) + owner Join.
    for (const rumor of genesis.controlRumors) {
      await this.publishToPlane(rt, rt.keys.control, rumor, { plaintext: true });
    }
    for (const rumor of genesis.guestbookRumors) {
      await this.publishToPlane(rt, rt.keys.guestbook, rumor, {});
    }
    await this.saveCommunityList();
    return genesis.material.community_id;
  }

  async joinByLink(url: string): Promise<string> {
    this.status$.next("Fetching invite…");
    const parsed = parseInviteLink(url);
    const relays = parsed.bootstrapRelays.length ? parsed.bootstrapRelays : DEFAULT_RELAYS;
    const events = await firstValueFrom(
      pool
        .request(relays, [{ kinds: [KIND.INVITE_BUNDLE], authors: [parsed.linkSigner] }])
        .pipe(toArray(), timeout(10000)),
    ).catch(() => [] as NostrEvent[]);

    const live = events
      .filter((e) => (e.tags.find((t) => t[0] === "vsk")?.[1] ?? "6") === "6")
      .sort((a, b) => b.created_at - a.created_at)[0];
    if (!live) throw new Error("invite bundle not found or revoked");

    const bundle: InviteBundle = decryptBundle(live.content, parsed.token);
    const material: JoinMaterial = {
      community_id: bundle.community_id,
      owner: bundle.owner,
      owner_salt: bundle.owner_salt,
      community_root: bundle.community_root,
      root_epoch: bundle.root_epoch,
      channels: bundle.channels ?? [],
      relays: bundle.relays ?? relays,
      name: bundle.name,
    };
    if (!verifyOwner(material)) throw new Error("invite failed owner verification");
    if (bundle.expires_at && Date.now() > bundle.expires_at) throw new Error("invite expired");

    if (this.runtimes.has(material.community_id)) return material.community_id;

    const rt = this.addRuntime(material);
    // Publish our Join (with attribution, CORD-05).
    const joinTags: string[][] = [["ms", String(Date.now() % 1000)]];
    if (bundle.creator_npub) joinTags.push(["invite", bundle.creator_npub, bundle.label ?? ""]);
    await this.publishToPlane(rt, rt.keys.guestbook, { kind: KIND.JOIN_LEAVE, content: "join", tags: joinTags }, {});
    await this.saveCommunityList();
    this.status$.next("");
    return material.community_id;
  }

  // ---- chat actions -------------------------------------------------------

  private channelKey(rt: Runtime, channelId: string): GroupKey {
    const key = rt.keys.channels.get(channelId);
    if (!key) throw new Error("unknown channel");
    return key;
  }

  private channelEpoch(rt: Runtime, channelId: string): number {
    const ch = rt.state$.value.channels.find((c) => c.channel_id === channelId);
    return ch?.private ? ch.epoch ?? 1 : rt.material.root_epoch;
  }

  async sendMessage(cid: string, channelId: string, text: string, replyTo?: { id: string; author: string }): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    await this.publishToPlane(rt, this.channelKey(rt, channelId), messageRumor(channelId, epoch, text, replyTo), {});
  }

  async react(cid: string, channelId: string, target: { id: string; author: string }, emoji: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    await this.publishToPlane(
      rt,
      this.channelKey(rt, channelId),
      reactionRumor(channelId, epoch, { ...target, kind: KIND.MESSAGE }, emoji),
      {},
    );
  }

  async editMessage(cid: string, channelId: string, targetId: string, text: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    await this.publishToPlane(rt, this.channelKey(rt, channelId), editRumor(channelId, epoch, targetId, text), {});
  }

  async deleteMessage(cid: string, channelId: string, targetId: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    await this.publishToPlane(rt, this.channelKey(rt, channelId), deleteRumor(channelId, epoch, targetId), {});
  }

  async sendTyping(cid: string, channelId: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    await this.publishToPlane(rt, this.channelKey(rt, channelId), typingRumor(channelId, epoch), { ephemeral: true });
  }

  // ---- admin actions ------------------------------------------------------

  private buildVac(rt: Runtime, actor: string): [string, string, string] | undefined {
    if (actor === rt.material.owner) return undefined;
    const eid = grantLocator(fromHex(rt.material.community_id), actor);
    const latest = this.latestEdition(rt, eid);
    if (!latest) return undefined;
    return [eid, String(latest.version), latest.hash];
  }

  private latestEdition(rt: Runtime, eid: string): { version: number; hash: string; content: string } | undefined {
    let best: { version: number; hash: string; content: string } | undefined;
    for (const d of rt.controlEvents.values()) {
      const r = d.rumor;
      if (r.tags.find((t) => t[0] === "eid")?.[1] !== eid) continue;
      const version = parseInt(r.tags.find((t) => t[0] === "ev")?.[1] ?? "1", 10);
      if (!best || version > best.version) {
        const prev = r.tags.find((t) => t[0] === "ep")?.[1];
        const hash = computeEditionHash({ vsk: 0, eid, version, prevHash: prev, content: r.content });
        best = { version, hash, content: r.content };
      }
    }
    return best;
  }

  private async publishEdition(rt: Runtime, vsk: number, eid: string, content: string): Promise<void> {
    const latest = this.latestEdition(rt, eid);
    const version = latest ? latest.version + 1 : 1;
    const vac = this.buildVac(rt, this.pubkey);
    const rumor = buildEdition({ vsk, eid, version, prevHash: latest?.hash, content, vac });
    await this.publishToPlane(rt, rt.keys.control, rumor, { plaintext: true });
  }

  async editMetadata(cid: string, patch: Partial<CommunityMetadata>): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const current = rt.state$.value.metadata ?? { name: rt.material.name, relays: rt.material.relays };
    const next: CommunityMetadata = { ...current, ...patch };
    await this.publishEdition(rt, VSK.METADATA, rt.material.community_id, JSON.stringify(next));
  }

  async createChannel(cid: string, name: string, isPrivate: boolean): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const channelId = toHex(generateSecretKey());
    const content: ChannelMetadata = { channel_id: channelId, name, private: isPrivate };
    if (isPrivate) {
      // A private channel mints its own key; grant-holders get it in invites.
      const key = toHex(generateSecretKey());
      rt.material.channels.push({ id: channelId, key, epoch: 1, name });
    }
    await this.publishEdition(rt, VSK.CHANNEL, channelId, JSON.stringify({ name, private: isPrivate }));
    void content;
  }

  async deleteChannel(cid: string, channelId: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const ch = rt.state$.value.channels.find((c) => c.channel_id === channelId);
    if (!ch) return;
    await this.publishEdition(rt, VSK.CHANNEL, channelId, JSON.stringify({ name: ch.name, private: ch.private, deleted: true }));
  }

  async createRole(cid: string, name: string, position: number, permissions: bigint): Promise<string> {
    const rt = this.runtimes.get(cid)!;
    const roleId = toHex(generateSecretKey());
    const role: Role = {
      role_id: roleId,
      name,
      position,
      permissions: permissions.toString(),
      scope: { kind: "server" },
      color: 0,
    };
    await this.publishEdition(rt, VSK.ROLE, roleId, JSON.stringify(role));
    return roleId;
  }

  async grantRoles(cid: string, member: string, roleIds: string[]): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const eid = grantLocator(fromHex(rt.material.community_id), member);
    await this.publishEdition(rt, VSK.GRANT, eid, JSON.stringify({ member, role_ids: roleIds }));
  }

  async kick(cid: string, member: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    // Strip roles first, then the cooperative Kick directive (CORD-04 §6).
    await this.grantRoles(cid, member, []);
    const vac = this.buildVac(rt, this.pubkey);
    const tags: string[][] = [["ms", String(Date.now() % 1000)], ["p", member]];
    if (vac) tags.push(["vac", ...vac]);
    await this.publishToPlane(rt, rt.keys.guestbook, { kind: KIND.KICK, content: "", tags }, {});
  }

  async ban(cid: string, member: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const current = new Set(rt.state$.value.banlist);
    current.add(member);
    const eid = banlistLocator(fromHex(rt.material.community_id));
    await this.publishEdition(rt, VSK.BANLIST, eid, JSON.stringify([...current]));
    await this.grantRoles(cid, member, []);
    // NOTE: full enforcement also requires a Refounding (rekey) — CORD-06.
  }

  async unban(cid: string, member: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const current = new Set(rt.state$.value.banlist);
    current.delete(member);
    const eid = banlistLocator(fromHex(rt.material.community_id));
    await this.publishEdition(rt, VSK.BANLIST, eid, JSON.stringify([...current]));
  }

  async dissolve(cid: string): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    if (this.pubkey !== rt.material.owner) throw new Error("only the owner can dissolve");
    const key = dissolvedGroupKey(fromHex(rt.material.community_id));
    await this.publishToPlane(
      rt,
      key,
      { kind: KIND.CONTROL, content: "", tags: [["vsk", "10"], ["eid", "00".repeat(32)]] },
      { plaintext: true },
    );
  }

  async leave(cid: string): Promise<void> {
    const rt = this.runtimes.get(cid);
    if (!rt) return;
    await this.publishToPlane(
      rt,
      rt.keys.guestbook,
      { kind: KIND.JOIN_LEAVE, content: "leave", tags: [["ms", String(Date.now() % 1000)]] },
      {},
    );
    rt.sub?.unsubscribe();
    this.runtimes.delete(cid);
    this.emitCommunities();
    await this.saveCommunityList();
  }

  // ---- invites ------------------------------------------------------------

  async createInvite(cid: string, base: string): Promise<string> {
    const rt = this.runtimes.get(cid)!;
    const token = newInviteToken();
    const linkSk = generateSecretKey();
    const linkPub = getPublicKey(linkSk);

    const state = rt.state$.value;
    // Include private-channel keys the inviter holds so the joiner can read them.
    const channels = rt.material.channels.map((c) => ({ id: c.id, key: c.key, epoch: c.epoch, name: c.name }));

    const bundle: InviteBundle = {
      community_id: rt.material.community_id,
      owner: rt.material.owner,
      owner_salt: rt.material.owner_salt,
      community_root: rt.material.community_root,
      root_epoch: rt.material.root_epoch,
      channels,
      relays: rt.material.relays,
      name: state.metadata?.name ?? rt.material.name,
      icon: state.metadata?.icon,
      creator_npub: this.pubkey,
    };

    const template = buildBundleEventTemplate(bundle, token);
    const signed = finalizeEvent(template, linkSk);
    eventStore.add(signed);
    const inviteRelays = rt.material.relays.length ? rt.material.relays : DEFAULT_RELAYS;
    pool.publish(inviteRelays, signed).catch((err) => console.warn("bundle publish failed", err));

    // Register the link into the community (CORD-05 §5) so it counts as Public.
    const registryEid = inviteLinksLocator(fromHex(rt.material.community_id), this.pubkey);
    const existing = this.latestEdition(rt, registryEid);
    let links: string[] = [];
    try {
      if (existing) links = JSON.parse(existing.content) as string[];
    } catch { /* ignore */ }
    if (!links.includes(linkPub)) links.push(linkPub);
    await this.publishEdition(rt, VSK.INVITE_REGISTRY, registryEid, JSON.stringify(links));

    return buildInviteLink(base, linkPub, token, rt.material.relays.length ? rt.material.relays : DEFAULT_RELAYS);
  }

  // ---- internal: runtime & subscriptions ----------------------------------

  private addRuntime(material: JoinMaterial): Runtime {
    const rt: Runtime = {
      material,
      keys: deriveKeys(material, []),
      controlEvents: new Map(),
      guestbookEvents: new Map(),
      channelEvents: new Map(),
      observed: new Map(),
      planeMap: new Map(),
      dissolved: false,
      state$: new BehaviorSubject<CommunityState>(emptyState(material)),
      messages$: new Map(),
      typing: new Map(),
      typing$: new Map(),
    };
    this.runtimes.set(material.community_id, rt);
    this.resubscribe(rt);
    this.emitCommunities();
    return rt;
  }

  private buildPlaneMap(rt: Runtime): Map<string, PlaneInfo> {
    const map = new Map<string, PlaneInfo>();
    map.set(rt.keys.control.pk, { type: "control", convKey: rt.keys.control.convKey });
    map.set(rt.keys.guestbook.pk, { type: "guestbook", convKey: rt.keys.guestbook.convKey });
    const dissolved = dissolvedGroupKey(fromHex(rt.material.community_id));
    map.set(dissolved.pk, { type: "dissolved", convKey: dissolved.convKey });
    for (const [channelId, key] of rt.keys.channels) {
      map.set(key.pk, { type: "channel", convKey: key.convKey, channelId });
    }
    return map;
  }

  private resubscribe(rt: Runtime): void {
    const map = this.buildPlaneMap(rt);
    const oldKeys = [...rt.planeMap.keys()].sort().join(",");
    const newKeys = [...map.keys()].sort().join(",");
    if (rt.sub && oldKeys === newKeys) return; // no change
    rt.planeMap = map;
    rt.sub?.unsubscribe();
    const authors = [...map.keys()];
    const relays = rt.material.relays.length ? rt.material.relays : DEFAULT_RELAYS;
    rt.sub = pool
      .subscription(relays, [{ kinds: [KIND.WRAP, KIND.WRAP_EPHEMERAL], authors }])
      .subscribe((event) => {
        if (typeof event === "string") return;
        this.ingest(rt, event as NostrEvent);
      });
  }

  private ingest(rt: Runtime, event: NostrEvent): void {
    const info = rt.planeMap.get(event.pubkey);
    if (!info) return;
    if (rt.controlEvents.has(event.id) || rt.guestbookEvents.has(event.id)) return;
    const decoded = decodeStreamEvent(event, info.convKey);
    if (!decoded) return;
    eventStore.add(event);

    const prev = rt.observed.get(decoded.author) ?? 0;
    if (decoded.ms > prev) rt.observed.set(decoded.author, decoded.ms);

    switch (info.type) {
      case "control":
        rt.controlEvents.set(event.id, decoded);
        this.scheduleRefold(rt);
        break;
      case "guestbook":
        rt.guestbookEvents.set(event.id, decoded);
        this.scheduleRefold(rt);
        break;
      case "dissolved":
        if (decoded.author === rt.material.owner && decoded.rumor.tags.some((t) => t[0] === "vsk" && t[1] === "10")) {
          rt.dissolved = true;
          this.scheduleRefold(rt);
        }
        break;
      case "channel": {
        const channelId = info.channelId!;
        if (!checkChatBinding(decoded.rumor.tags, channelId, info.epoch ?? this.channelEpoch(rt, channelId))) {
          // epoch may differ per held key; accept if channel matches at least
          if (decoded.rumor.tags.find((t) => t[0] === "channel")?.[1] !== channelId) return;
        }
        if (decoded.rumor.kind === KIND.TYPING) {
          this.handleTyping(rt, channelId, decoded.author);
          return;
        }
        let ch = rt.channelEvents.get(channelId);
        if (!ch) {
          ch = new Map();
          rt.channelEvents.set(channelId, ch);
        }
        ch.set(event.id, decoded);
        this.recomputeMessages(rt, channelId);
        break;
      }
    }
  }

  private scheduleRefold(rt: Runtime): void {
    if (rt.refoldTimer) return;
    rt.refoldTimer = setTimeout(() => {
      rt.refoldTimer = undefined;
      this.refold(rt);
    }, 60);
  }

  private refold(rt: Runtime): void {
    const state = foldControl([...rt.controlEvents.values()], rt.material);
    rt.keys = deriveKeys(rt.material, state.channels);

    const rolesMap = new Map<string, Role>(state.roles.map((r) => [r.role_id, r]));
    const standing = (m: string): Standing => resolveStanding(m, rt.material.owner, rolesMap, state.grants);
    state.members = foldMembers([...rt.guestbookEvents.values()], rt.observed, state.banlist, standing);
    state.dissolved = rt.dissolved;

    rt.state$.next(state);
    this.resubscribe(rt); // pick up any newly-revealed channels
    // Recompute any open channel views (channel keys may have changed epoch).
    for (const channelId of rt.messages$.keys()) this.recomputeMessages(rt, channelId);
    this.emitCommunities();
  }

  private emitCommunities(): void {
    this.communities$.next([...this.runtimes.values()].map((r) => r.state$.value));
  }

  // ---- message assembly ---------------------------------------------------

  private recomputeMessages(rt: Runtime, channelId: string): void {
    const subj = rt.messages$.get(channelId);
    if (!subj) return;
    const events = rt.channelEvents.get(channelId);
    const byId = new Map<string, ChatMessage>();
    const reactions = new Map<string, Map<string, Set<string>>>(); // target -> emoji -> authors
    const edits: DecodedEvent[] = [];
    const deletes: DecodedEvent[] = [];

    if (events) {
      const sorted = [...events.values()].sort((a, b) => a.ms - b.ms);
      for (const d of sorted) {
        const r = d.rumor;
        if (r.kind === KIND.MESSAGE) {
          const q = r.tags.find((t) => t[0] === "q");
          byId.set(r.id, {
            id: r.id,
            author: d.author,
            content: r.content,
            ms: d.ms,
            deleted: false,
            replyTo: q ? { id: q[1], author: q[3] ?? "" } : undefined,
            reactions: [],
          });
        } else if (r.kind === KIND.EDIT) {
          edits.push(d);
        } else if (r.kind === KIND.DELETE) {
          deletes.push(d);
        } else if (r.kind === KIND.REACTION) {
          const target = r.tags.find((t) => t[0] === "e")?.[1];
          if (!target) continue;
          let emap = reactions.get(target);
          if (!emap) {
            emap = new Map();
            reactions.set(target, emap);
          }
          let set = emap.get(r.content);
          if (!set) {
            set = new Set();
            emap.set(r.content, set);
          }
          set.add(d.author);
        }
      }
    }

    // Apply edits/deletes only from the message's own author.
    for (const d of edits) {
      const targetId = d.rumor.tags.find((t) => t[0] === "e")?.[1];
      const msg = targetId ? byId.get(targetId) : undefined;
      if (msg && msg.author === d.author) msg.edited = d.rumor.content;
    }
    for (const d of deletes) {
      for (const t of d.rumor.tags) {
        if (t[0] !== "e") continue;
        const msg = byId.get(t[1]);
        if (msg && msg.author === d.author) msg.deleted = true;
      }
    }
    for (const [target, emap] of reactions) {
      const msg = byId.get(target);
      if (!msg) continue;
      msg.reactions = [...emap.entries()].map(([emoji, authors]) => ({
        emoji,
        count: authors.size,
        authors: [...authors],
      }));
    }

    subj.next([...byId.values()].sort((a, b) => a.ms - b.ms));
  }

  private handleTyping(rt: Runtime, channelId: string, author: string): void {
    if (author === this.pubkey) return;
    let map = rt.typing.get(channelId);
    if (!map) {
      map = new Map();
      rt.typing.set(channelId, map);
    }
    map.set(author, Date.now() + TYPING_TTL);
    this.emitTyping(rt, channelId);
    setTimeout(() => this.emitTyping(rt, channelId), TYPING_TTL + 100);
  }

  private emitTyping(rt: Runtime, channelId: string): void {
    const subj = rt.typing$.get(channelId);
    if (!subj) return;
    const map = rt.typing.get(channelId);
    const now = Date.now();
    const active: string[] = [];
    if (map) for (const [author, expiry] of map) if (expiry > now) active.push(author);
    subj.next(active);
  }

  // ---- publishing ---------------------------------------------------------

  private async publishToPlane(
    rt: Runtime,
    key: GroupKey,
    rumor: { kind: number; content: string; tags: string[][]; created_at?: number },
    opts: { plaintext?: boolean; ephemeral?: boolean },
  ): Promise<string> {
    const { wrap, rumorId } = await createStreamEvent({
      streamSk: key.sk,
      convKey: key.convKey,
      author: this.signer,
      rumor,
      plaintextSeal: opts.plaintext,
      ephemeral: opts.ephemeral,
    });
    const relays = rt.material.relays.length ? rt.material.relays : DEFAULT_RELAYS;
    // Optimistic local echo first, so the UI updates even before relays ack.
    if (!opts.ephemeral) this.ingest(rt, wrap);
    else this.handleTyping(rt, rumor.tags.find((t) => t[0] === "channel")?.[1] ?? "", this.pubkey);
    // Publish in the background — never block the UI on relay round-trips.
    pool.publish(relays, wrap).catch((err) => console.warn("publish failed", err));
    return rumorId;
  }

  // ---- community list (kind 13302) ----------------------------------------

  private async loadCommunityList(): Promise<void> {
    try {
      const events = await firstValueFrom(
        pool
          .request(DEFAULT_RELAYS, [{ kinds: [KIND.COMMUNITY_LIST], authors: [this.pubkey] }])
          .pipe(toArray(), timeout(8000)),
      ).catch(() => [] as NostrEvent[]);
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!latest || !this.signer.nip44) return;
      const json = await this.signer.nip44.decrypt(this.pubkey, latest.content);
      const list = JSON.parse(json) as { entries: { current: JoinMaterial }[]; tombstones?: unknown[] };
      const tombstoned = new Set(
        (list.tombstones ?? []).map((t) => (t as { community_id: string }).community_id),
      );
      for (const entry of list.entries ?? []) {
        const m = entry.current;
        if (!m?.community_id || tombstoned.has(m.community_id)) continue;
        if (!this.runtimes.has(m.community_id)) this.addRuntime(m);
      }
    } catch (err) {
      console.warn("failed to load community list", err);
    }
  }

  private async saveCommunityList(): Promise<void> {
    if (!this.signer.nip44) return;
    try {
      const entries = [...this.runtimes.values()].map((rt) => ({
        community_id: rt.material.community_id,
        seed: rt.material,
        current: rt.material,
        added_at: Date.now(),
      }));
      const content = await this.signer.nip44.encrypt(this.pubkey, JSON.stringify({ entries, tombstones: [] }));
      const signed = await this.signer.signEvent({
        kind: KIND.COMMUNITY_LIST,
        content,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      eventStore.add(signed);
      pool.publish(DEFAULT_RELAYS, signed).catch((err) => console.warn("list publish failed", err));
    } catch (err) {
      console.warn("failed to save community list", err);
    }
  }

  // ---- helpers for UI -----------------------------------------------------

  standingOf(cid: string, member: string): Standing {
    const rt = this.runtimes.get(cid)!;
    const state = rt.state$.value;
    const rolesMap = new Map<string, Role>(state.roles.map((r) => [r.role_id, r]));
    return resolveStanding(member, rt.material.owner, rolesMap, state.grants);
  }

  canDo(cid: string, perm: bigint, targetPosition = 0xffffffff): boolean {
    const me = this.standingOf(cid, this.pubkey);
    return canActOn(me, { permissions: 0n, position: targetPosition, isOwner: false, roleIds: [] }, perm);
  }
}

export { PERM, ZERO_32 };
