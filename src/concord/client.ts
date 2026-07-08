// ConcordClient — the reactive engine.
//
// Uses applesauce (EventStore + RelayPool) for all Nostr I/O, and the Concord
// protocol layer (crypto/stream/control/guestbook/invite) to fold plane events
// into reactive community state. One instance per logged-in user.

import { BehaviorSubject, Subscription, firstValueFrom, timeout, toArray } from "rxjs";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools";
import type { NostrEvent } from "nostr-tools";

import { eventStore, pool } from "../nostr";
import {
  getEncryptedContent,
  isEncryptedContentUnlocked,
  setEncryptedContentCache,
  unlockEncryptedContent,
} from "applesauce-core/helpers";
import { getReactionEmoji } from "applesauce-common/helpers";
import { fromHex, toHex, ZERO_32 } from "../lib/bytes";
import { castUser } from "applesauce-core";
import { encryptImageBlob } from "../lib/image";
import { DEFAULT_BLOSSOM_SERVERS, dedupeServers, uploadBlob } from "../lib/blossom";
import { parseImeta, type MediaAttachment } from "../lib/imeta";
import {
  banlistLocator,
  baseRekeyGroupKey,
  controlGroupKey,
  dissolvedGroupKey,
  epochKeyCommitment,
  grantLocator,
  guestbookGroupKey,
  inviteLinksLocator,
} from "./crypto";
import {
  base64ToBytes,
  buildRekeyRumors,
  bytesToBase64,
  checkContinuity,
  decodeWrappedKey,
  encodeWrappedKey,
  findBlob,
  groupRotations,
  lowerKeyWins,
  parseRekey,
  rekeyLocator,
  ROOT_SCOPE_HEX,
} from "./rekey";
import { createStreamEvent, decodeStreamEventCached, rewrapSeal, splitTime } from "./stream";
import { clearCache, loadCache, saveCache, MAX_CHANNEL_CACHE } from "./cache";
import type { CachedEntry } from "./cache";
import { autoAuthenticate, authenticateStreamKeys } from "./relay-auth";
import { registerStreamKeys } from "./stream-auth";
import type { Signer } from "./stream";
import { foldControl } from "./control";
import {
  addToList,
  isCommunityLive,
  mergeCommunityLists,
  refreshCurrent,
  removeFromList,
  withinByteCap,
} from "./community-list";
import type { CommunityList } from "./community-list";
import { buildSnapshotRumors, foldMembers } from "./guestbook";
import { resolveStanding, canActOn, hasPerm } from "./permissions";
import type { Standing } from "./permissions";
import { createCommunity, deriveKeys, verifyOwner, voiceKeysFor } from "./community";
import type { CommunityKeys, VoiceKeys } from "./community";
import {
  foldVoicePresence,
  parsePresence,
  presenceTags,
  VOICE_HEARTBEAT_MS,
  VOICE_STALE_MS,
} from "./voice";
import type { VoicePresenceEntry, VoicePresenceFold } from "./voice";
import { buildEdition, computeEditionHash } from "./editions";
import {
  messageRumor,
  reactionRumor,
  deleteRumor,
  editRumor,
  checkChatBinding,
  type Emoji,
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
  type BlobPointer,
  type CommunityMetadata,
  type CommunityState,
  type DecodedEvent,
  type InviteBundle,
  type JoinMaterial,
  type Role,
} from "./types";

const DEFAULT_RELAYS = STOCK_RELAYS;

export interface ChatMessage {
  id: string;
  author: string;
  content: string;
  ms: number;
  edited?: string;
  deleted: boolean;
  replyTo?: { id: string; author: string };
  /** `emoji` is the reaction content (a unicode char or `:shortcode:`); `url` is set for NIP-30 custom emoji. */
  reactions: { emoji: string; url?: string; count: number; authors: string[] }[];
  /** Encrypted media/files parsed from the message's NIP-92 imeta tags. */
  attachments: MediaAttachment[];
  /** The message's NIP-30 `["emoji", …]` tags, for rendering `:shortcode:` inline. */
  emojiTags: string[][];
  /** The decoded plane event (rumor + wrapper metadata), retained for debugging ("view raw"). */
  raw: DecodedEvent;
}

interface PlaneInfo {
  type: "control" | "guestbook" | "channel" | "dissolved" | "rekey";
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
  /** CORD-06 rekey blobs seen at the next-epoch base-rekey address. */
  rekeyEvents: Map<string, DecodedEvent>;
  /** Guard: adopt/tombstone at most once per target epoch. */
  rekeyHandled: Set<number>;
  rekeyTimer?: ReturnType<typeof setTimeout>;
  /** stable subscription: control + guestbook + dissolved planes */
  controlSub?: Subscription;
  /** dynamic subscription: channel planes (reopened when the set changes) */
  channelSub?: Subscription;
  /** signature of the current channel author set, to avoid needless resubs */
  channelAuthors: string;
  state$: BehaviorSubject<CommunityState>;
  messages$: Map<string, BehaviorSubject<ChatMessage[]>>;
  /** CORD-07 §4: per voice-channel, the latest presence per author. */
  voicePresence: Map<string, Map<string, VoicePresenceEntry>>;
  /** channelId -> folded, staleness-decayed presence view. */
  presence$: Map<string, BehaviorSubject<VoicePresenceFold>>;
  /** Periodic decay so a `joined` that stops heartbeating ages out (§4). */
  presenceDecay?: ReturnType<typeof setInterval>;
  /** channelId -> our own heartbeat timer while we're in that call. */
  voiceHeartbeats: Map<string, ReturnType<typeof setInterval>>;
  refoldTimer?: ReturnType<typeof setTimeout>;
  persistTimer?: ReturnType<typeof setTimeout>;
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
  /** The authoritative 13302 document (CORD-02 §8): merged, never clobbered. */
  private communityList: CommunityList = { entries: [], tombstones: [] };

  constructor(signer: Signer, pubkey: string) {
    this.signer = signer;
    this.pubkey = pubkey;
  }

  // ---- lifecycle ----------------------------------------------------------

  private started = false;
  private authSub?: Subscription;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Answer NIP-42 challenges from community relays so they serve our events.
    this.authSub = autoAuthenticate(this.signer, this.pubkey);
    // Restore the Community List document (with tombstones) from the local
    // mirror first, so a leave that hasn't propagated to relays yet still
    // suppresses re-adding the community on reload (CORD-02 §8 liveness).
    this.communityList = this.loadCommunityListLocal();
    // Restore memberships from the local mirror (instant, offline-safe),
    // skipping any whose tombstone is already known locally, then reconcile
    // with the relay-published Community List (kind 13302).
    for (const m of this.loadMaterialsLocal()) {
      if (this.runtimes.has(m.community_id)) continue;
      if (!isCommunityLive(this.communityList, m.community_id)) continue;
      this.addRuntime(m);
    }
    await this.loadCommunityList();
  }

  private materialsKey(): string {
    return `concord:communities:${this.pubkey}`;
  }

  private communityListKey(): string {
    return `concord:community-list:${this.pubkey}`;
  }

  private loadCommunityListLocal(): CommunityList {
    try {
      const raw = localStorage.getItem(this.communityListKey());
      if (!raw) return { entries: [], tombstones: [] };
      const parsed = JSON.parse(raw) as CommunityList;
      if (!parsed || !Array.isArray(parsed.entries) || !Array.isArray(parsed.tombstones)) {
        return { entries: [], tombstones: [] };
      }
      return parsed;
    } catch {
      return { entries: [], tombstones: [] };
    }
  }

  private saveCommunityListLocal(): void {
    try {
      localStorage.setItem(this.communityListKey(), JSON.stringify(this.communityList));
    } catch (err) {
      console.warn("failed to mirror community list locally", err);
    }
  }

  private loadMaterialsLocal(): JoinMaterial[] {
    try {
      const raw = localStorage.getItem(this.materialsKey());
      return raw ? (JSON.parse(raw) as JoinMaterial[]) : [];
    } catch {
      return [];
    }
  }

  private saveMaterialsLocal(): void {
    try {
      const mats = [...this.runtimes.values()].map((r) => r.material);
      localStorage.setItem(this.materialsKey(), JSON.stringify(mats));
    } catch (err) {
      console.warn("failed to mirror communities locally", err);
    }
  }

  stop(): void {
    this.authSub?.unsubscribe();
    for (const rt of this.runtimes.values()) {
      rt.controlSub?.unsubscribe();
      rt.channelSub?.unsubscribe();
      if (rt.presenceDecay) clearInterval(rt.presenceDecay);
      for (const timer of rt.voiceHeartbeats.values()) clearInterval(timer);
      rt.voiceHeartbeats.clear();
      if (rt.persistTimer) {
        clearTimeout(rt.persistTimer);
        this.persistCache(rt); // flush any pending cache write before teardown
      }
    }
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

  // ---- voice (CORD-07) ----------------------------------------------------

  /** The folded call-presence view for a voice channel (CORD-07 §4). */
  getVoicePresence$(cid: string, channelId: string): BehaviorSubject<VoicePresenceFold> {
    const rt = this.runtimes.get(cid)!;
    let subj = rt.presence$.get(channelId);
    if (!subj) {
      subj = new BehaviorSubject<VoicePresenceFold>({ present: [], claims: new Map() });
      rt.presence$.set(channelId, subj);
      this.recomputePresence(rt, channelId);
      this.ensurePresenceDecay(rt);
    }
    return subj;
  }

  /** The voice keys (SFU room + media root) for a channel, or undefined if the
   *  channel isn't a voice channel or isn't known. */
  voiceKeys(cid: string, channelId: string): VoiceKeys | undefined {
    const rt = this.runtimes.get(cid);
    const ch = rt?.state$.value.channels.find((c) => c.channel_id === channelId);
    if (!rt || !ch?.voice) return undefined;
    return voiceKeysFor(rt.material, ch);
  }

  private ingestPresence(rt: Runtime, channelId: string, decoded: DecodedEvent): void {
    const entry = parsePresence(decoded);
    if (!entry) return;
    // Reject far-future stamps so a forged date can't squat "latest".
    if (entry.ms > Date.now() + 60_000) return;
    let byAuthor = rt.voicePresence.get(channelId);
    if (!byAuthor) {
      byAuthor = new Map();
      rt.voicePresence.set(channelId, byAuthor);
    }
    const prev = byAuthor.get(entry.author);
    // Latest wins (ms basis, rumor-id tiebreak) — a replayed older ping loses.
    if (prev && !(entry.ms > prev.ms || (entry.ms === prev.ms && entry.rumorId < prev.rumorId))) return;
    byAuthor.set(entry.author, entry);
    this.recomputePresence(rt, channelId);
  }

  private recomputePresence(rt: Runtime, channelId: string): void {
    const subj = rt.presence$.get(channelId);
    if (!subj) return;
    const now = Date.now();
    const byAuthor = rt.voicePresence.get(channelId);
    if (byAuthor) {
      // Prune long-stale entries so the map stays bounded; anything a pruned
      // entry could out-rank is even older, so this never resurrects one.
      for (const [author, e] of byAuthor) if (now - e.ms > VOICE_STALE_MS) byAuthor.delete(author);
    }
    subj.next(foldVoicePresence(byAuthor ? [...byAuthor.values()] : [], now));
  }

  /** One shared decay ticker per runtime re-folds every open call so a
   *  participant who stops heartbeating ages out even with no new events. */
  private ensurePresenceDecay(rt: Runtime): void {
    if (rt.presenceDecay) return;
    rt.presenceDecay = setInterval(() => {
      for (const channelId of rt.presence$.keys()) this.recomputePresence(rt, channelId);
    }, VOICE_STALE_MS / 6);
  }

  /**
   * Announce joining a call (CORD-07 §4): publish a `joined` (carrying the
   * broker-assigned SFU identity + broker rendezvous hint) now and every 30s.
   * Idempotent per channel — re-joining replaces the prior heartbeat.
   */
  async joinVoice(cid: string, channelId: string, identity: string, broker: string): Promise<void> {
    const rt = this.runtimes.get(cid);
    if (!rt) return;
    this.stopHeartbeat(rt, channelId);
    const beat = () => void this.publishPresence(rt, channelId, "joined", identity, broker);
    beat();
    rt.voiceHeartbeats.set(channelId, setInterval(beat, VOICE_HEARTBEAT_MS));
    this.ensurePresenceDecay(rt);
  }

  /** Announce leaving a call (§4): best-effort `left`; a missed one heals by
   *  staleness. Stops our heartbeat. */
  async leaveVoice(cid: string, channelId: string): Promise<void> {
    const rt = this.runtimes.get(cid);
    if (!rt) return;
    if (!rt.voiceHeartbeats.has(channelId)) return;
    this.stopHeartbeat(rt, channelId);
    await this.publishPresence(rt, channelId, "left");
  }

  private stopHeartbeat(rt: Runtime, channelId: string): void {
    const timer = rt.voiceHeartbeats.get(channelId);
    if (timer) {
      clearInterval(timer);
      rt.voiceHeartbeats.delete(channelId);
    }
  }

  /** Publish one presence rumor over the channel's own address (ephemeral wrap)
   *  and reflect it locally so our own roster tile appears immediately. */
  private async publishPresence(
    rt: Runtime,
    channelId: string,
    status: "joined" | "left",
    identity?: string,
    broker?: string,
  ): Promise<void> {
    const epoch = this.channelEpoch(rt, channelId);
    const key = this.channelKey(rt, channelId);
    const { created_at, ms } = splitTime();
    const rumor = {
      kind: KIND.VOICE_PRESENCE,
      content: status,
      created_at,
      tags: [
        ["channel", channelId],
        ["epoch", String(epoch)],
        ...presenceTags(status, identity, broker),
        ["ms", String(ms)],
      ],
    };
    const { wrap } = await createStreamEvent({
      streamSk: key.sk,
      convKey: key.convKey,
      author: this.signer,
      rumor,
      ephemeral: true,
    });
    // Ephemeral publishToPlane skips the local echo, so reflect presence into
    // our own fold directly (the relay echo would otherwise be our only source).
    const decoded = decodeStreamEventCached(wrap, key.convKey);
    if (decoded) this.ingestPresence(rt, channelId, decoded);
    const relays = rt.material.relays.length ? rt.material.relays : DEFAULT_RELAYS;
    pool.publish(relays, wrap).catch((err) => console.warn("presence publish failed", err));
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

  async sendMessage(
    cid: string,
    channelId: string,
    text: string,
    replyTo?: { id: string; author: string },
    files?: File[],
    emojis?: Emoji[],
  ): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    // Encrypt + upload each file, appending its URL to the content and an imeta
    // tag carrying the per-file key (see lib/imeta.ts, lib/image.ts).
    let content = text;
    let attachments: MediaAttachment[] | undefined;
    if (files?.length) {
      const servers = await this.blossomServers(cid);
      attachments = [];
      for (const file of files) {
        const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
        const url = await uploadBlob(ciphertext, servers, this.signer);
        attachments.push({
          url,
          mime: file.type || undefined,
          originalHash: hash,
          encryption: { algorithm: "aes-gcm", key, nonce },
        });
        content = content ? `${content}\n${url}` : url;
      }
    }
    await this.publishToPlane(
      rt,
      this.channelKey(rt, channelId),
      messageRumor(channelId, epoch, content, replyTo, attachments, emojis),
      {},
    );
  }

  async react(
    cid: string,
    channelId: string,
    target: { id: string; author: string },
    reaction: string | Emoji,
  ): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const epoch = this.channelEpoch(rt, channelId);
    await this.publishToPlane(
      rt,
      this.channelKey(rt, channelId),
      reactionRumor(channelId, epoch, { ...target, kind: KIND.MESSAGE }, reaction),
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

  /**
   * Encrypt an image, upload the ciphertext to the user's Blossom servers, and
   * publish the resulting {@link BlobPointer} into the community metadata as the
   * icon or banner (CORD-02 §6). The plaintext never leaves the device.
   */
  async setCommunityImage(cid: string, which: "icon" | "banner", file: File | Blob): Promise<void> {
    const { ciphertext, key, nonce, hash } = await encryptImageBlob(file);
    const servers = await this.blossomServers(cid);
    const url = await uploadBlob(ciphertext, servers, this.signer);
    const pointer: BlobPointer = { url, key, nonce, hash };
    await this.editMetadata(cid, { [which]: pointer });
  }

  /** Clear the community icon or banner. */
  async removeCommunityImage(cid: string, which: "icon" | "banner"): Promise<void> {
    await this.editMetadata(cid, { [which]: undefined });
  }

  /**
   * Blossom servers to upload to: the community's own list if it defines one,
   * otherwise the user's kind-10063 list (read reactively via applesauce's
   * `User` cast), falling back to the app defaults only if neither exists.
   */
  private async blossomServers(cid: string): Promise<string[]> {
    const communityServers = this.runtimes.get(cid)?.state$.value.metadata?.blossom_servers ?? [];
    if (communityServers.length) return dedupeServers(communityServers);

    // The `User` cast reads/loads the user's kind-10063 list (a loader is wired
    // in nostr.ts, so this resolves even on a cold store).
    const urls = await castUser(this.pubkey, eventStore)
      .blossomServers$.$first(3000)
      .catch(() => undefined as URL[] | undefined);
    const userServers = (urls ?? []).map((u) => u.toString());
    if (userServers.length) return dedupeServers(userServers);

    return DEFAULT_BLOSSOM_SERVERS;
  }

  async createChannel(cid: string, name: string, isPrivate: boolean, voice = false): Promise<void> {
    const rt = this.runtimes.get(cid)!;
    const channelId = toHex(generateSecretKey());
    if (isPrivate) {
      // A private channel mints its own key; grant-holders get it in invites.
      const key = toHex(generateSecretKey());
      rt.material.channels.push({ id: channelId, key, epoch: 1, name });
      // Persist the key both locally and into our Community List (13302), or it
      // is lost on reload.
      this.saveMaterialsLocal();
      await this.saveCommunityList();
    }
    const content: Record<string, unknown> = { name, private: isPrivate };
    if (voice) content.voice = true;
    await this.publishEdition(rt, VSK.CHANNEL, channelId, JSON.stringify(content));
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
    rt.controlSub?.unsubscribe();
    rt.channelSub?.unsubscribe();
    if (rt.persistTimer) clearTimeout(rt.persistTimer);
    clearCache(cid);
    this.runtimes.delete(cid);
    // Tombstone the membership so the leave propagates across devices/clients
    // (a bare omission would merge back as still-joined — CORD-02 §8).
    this.communityList = removeFromList(this.communityList, cid, Date.now());
    // Persist the tombstone locally before the async relay publish so a reload
    // before propagation still suppresses the community (CORD-02 §8).
    this.saveCommunityListLocal();
    this.saveMaterialsLocal();
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
      rekeyEvents: new Map(),
      rekeyHandled: new Set(),
      channelAuthors: "",
      state$: new BehaviorSubject<CommunityState>(emptyState(material)),
      messages$: new Map(),
      voicePresence: new Map(),
      presence$: new Map(),
      voiceHeartbeats: new Map(),
    };
    this.runtimes.set(material.community_id, rt);
    // Rehydrate from the local cache first, so channels/members are visible
    // immediately, then fold and open relay subscriptions to sync anything new.
    this.hydrate(rt);
    this.refold(rt);
    this.openControlSub(rt);
    this.reconcileChannelSub(rt);
    this.saveMaterialsLocal();
    this.emitCommunities();
    return rt;
  }

  private relaysFor(rt: Runtime): string[] {
    return rt.material.relays.length ? rt.material.relays : DEFAULT_RELAYS;
  }

  /**
   * Subscribe to gift wraps (kind 1059/21059) authored by `authors` across the
   * community's relays. `waitForAuth: authors` holds each relay's REQ until EVERY
   * queried stream author is authenticated (NIP-42) on that connection and
   * re-issues it after a reconnect; `authenticateStreamKeys` drives that
   * authentication per relay. Wraps stream into `ingest`; the returned
   * Subscription tears every relay's REQ (and auth driver) down together.
   */
  private subscribeWraps(rt: Runtime, authors: string[]): Subscription {
    const relays = this.relaysFor(rt);
    const filters = [{ kinds: [KIND.WRAP, KIND.WRAP_EPHEMERAL], authors }];
    const sub = new Subscription();
    for (const url of relays) sub.add(authenticateStreamKeys(pool.relay(url)));
    sub.add(
      pool.subscription(relays, filters, { waitForAuth: authors }).subscribe((event) => {
        this.ingest(rt, event as NostrEvent);
      }),
    );
    return sub;
  }

  /** The control/guestbook/dissolved planes never change address within an
   * epoch, so this subscription is opened once and never torn down mid-sync. */
  private openControlSub(rt: Runtime): void {
    const control = rt.keys.control;
    const guestbook = rt.keys.guestbook;
    const dissolved = dissolvedGroupKey(fromHex(rt.material.community_id));
    rt.planeMap.set(control.pk, { type: "control", convKey: control.convKey });
    rt.planeMap.set(guestbook.pk, { type: "guestbook", convKey: guestbook.convKey });
    rt.planeMap.set(dissolved.pk, { type: "dissolved", convKey: dissolved.convKey });
    // The NEXT epoch's base-rekey address (CORD-06 §2): a Refounding publishes
    // the new community_root here, keyed by the PRIOR root, so every current
    // holder converges. Subscribe now so an armada refounding is picked up live.
    const nextEpoch = rt.material.root_epoch + 1;
    const nextBaseRekey = baseRekeyGroupKey(
      fromHex(rt.material.community_root),
      fromHex(rt.material.community_id),
      nextEpoch,
    );
    rt.planeMap.set(nextBaseRekey.pk, { type: "rekey", convKey: nextBaseRekey.convKey, epoch: nextEpoch });
    // Register the core stream keys so an auth-gating relay can be answered as
    // these derived addresses (NIP-42) before the REQ is served.
    registerStreamKeys([control, guestbook, dissolved, nextBaseRekey]);
    const authors = [control.pk, guestbook.pk, dissolved.pk, nextBaseRekey.pk];
    rt.controlSub?.unsubscribe();
    rt.controlSub = this.subscribeWraps(rt, authors);
  }

  /** Reopen the channel subscription only when the set of channel addresses
   * actually changes — so discovering a channel never disturbs the control
   * subscription (which was the source of a mid-sync teardown race). */
  private reconcileChannelSub(rt: Runtime): void {
    for (const [channelId, key] of rt.keys.channels) {
      // Record the epoch this key derives at, so the receive-side binding check
      // (CORD-03 §44) can strict-compare the rumor's `epoch` tag against the
      // epoch whose key actually decrypted the wrap.
      rt.planeMap.set(key.pk, { type: "channel", convKey: key.convKey, channelId, epoch: this.channelEpoch(rt, channelId) });
    }
    // Register channel stream keys so the channel REQ can pass an auth gate.
    registerStreamKeys([...rt.keys.channels.values()]);
    const authors = [...rt.keys.channels.values()].map((k) => k.pk).sort();
    const sig = authors.join(",");
    if (sig === rt.channelAuthors) return;
    rt.channelAuthors = sig;
    rt.channelSub?.unsubscribe();
    if (authors.length === 0) return;
    rt.channelSub = this.subscribeWraps(rt, authors);
  }

  /** True when this wrap has already been folded into the plane it belongs to,
   * so a relay re-serving it (reload, reconnect, our own publish echoed back, an
   * overlapping subscription) needn't be decrypted or folded again. */
  private haveWrap(rt: Runtime, info: PlaneInfo, id: string): boolean {
    switch (info.type) {
      case "control":
        return rt.controlEvents.has(id);
      case "guestbook":
        return rt.guestbookEvents.has(id);
      case "channel":
        return rt.channelEvents.get(info.channelId!)?.has(id) ?? false;
      default:
        return false; // dissolved: a tiny, one-shot plane — let it fall through
    }
  }

  private ingest(rt: Runtime, event: NostrEvent): void {
    const info = rt.planeMap.get(event.pubkey);
    if (!info) return;
    // Cross-plane dedup (previously only control/guestbook were guarded, so
    // channel wraps were re-decrypted on every reload and every relay echo).
    if (event.kind !== KIND.WRAP_EPHEMERAL && this.haveWrap(rt, info, event.id)) return;
    // Add to the applesauce EventStore first: it dedups by id and hands back the
    // canonical instance, and decodeStreamEventCached memoises the decode on that
    // instance's symbol — so even paths that slip past haveWrap decrypt only once.
    const canonical = (eventStore.add(event) as NostrEvent | null) ?? event;
    const decoded = decodeStreamEventCached(canonical, info.convKey);
    if (!decoded) return;

    const prev = rt.observed.get(decoded.author) ?? 0;
    if (decoded.ms > prev) rt.observed.set(decoded.author, decoded.ms);

    switch (info.type) {
      case "control":
        rt.controlEvents.set(event.id, decoded);
        this.scheduleRefold(rt);
        this.schedulePersist(rt);
        break;
      case "guestbook":
        rt.guestbookEvents.set(event.id, decoded);
        this.scheduleRefold(rt);
        this.schedulePersist(rt);
        break;
      case "dissolved":
        if (decoded.author === rt.material.owner && decoded.rumor.tags.some((t) => t[0] === "vsk" && t[1] === "10")) {
          rt.dissolved = true;
          this.scheduleRefold(rt);
        }
        break;
      case "rekey":
        rt.rekeyEvents.set(event.id, decoded);
        this.scheduleRekeyCheck(rt);
        break;
      case "channel": {
        const channelId = info.channelId!;
        // CORD-03 §44: the receiver MUST check both `channel` and `epoch`
        // strict-equal against the channel/epoch whose key opened the wrap, and
        // drop any mismatch — this is the anti-replay guarantee (no member can
        // splice a rumor into another channel or replay it across an epoch).
        if (!checkChatBinding(decoded.rumor.tags, channelId, info.epoch ?? this.channelEpoch(rt, channelId))) {
          return;
        }
        // Voice presence (CORD-07 §4) rides the Channel's own address but is not
        // chat: route it to the presence fold, never into the message store or
        // the persisted cache (it's ephemeral, nothing worth storing).
        if (decoded.rumor.kind === KIND.VOICE_PRESENCE) {
          this.ingestPresence(rt, channelId, decoded);
          return;
        }
        let ch = rt.channelEvents.get(channelId);
        if (!ch) {
          ch = new Map();
          rt.channelEvents.set(channelId, ch);
        }
        ch.set(event.id, decoded);
        this.recomputeMessages(rt, channelId);
        this.schedulePersist(rt);
        break;
      }
    }
  }

  // ---- local cache (survives reload independent of relay behaviour) --------

  private hydrate(rt: Runtime): void {
    for (const entry of loadCache(rt.material.community_id)) {
      const d = entry.decoded;
      if (entry.plane === "control") rt.controlEvents.set(d.wrapId, d);
      else if (entry.plane === "guestbook") rt.guestbookEvents.set(d.wrapId, d);
      else if (entry.plane === "channel" && entry.channelId) {
        let ch = rt.channelEvents.get(entry.channelId);
        if (!ch) {
          ch = new Map();
          rt.channelEvents.set(entry.channelId, ch);
        }
        ch.set(d.wrapId, d);
      }
      const prev = rt.observed.get(d.author) ?? 0;
      if (d.ms > prev) rt.observed.set(d.author, d.ms);
    }
  }

  private schedulePersist(rt: Runtime): void {
    if (rt.persistTimer) return;
    rt.persistTimer = setTimeout(() => {
      rt.persistTimer = undefined;
      this.persistCache(rt);
    }, 800);
  }

  private persistCache(rt: Runtime): void {
    const entries: CachedEntry[] = [];
    for (const d of rt.controlEvents.values()) entries.push({ plane: "control", decoded: d });
    for (const d of rt.guestbookEvents.values()) entries.push({ plane: "guestbook", decoded: d });
    for (const [channelId, m] of rt.channelEvents) {
      const recent = [...m.values()].sort((a, b) => a.ms - b.ms).slice(-MAX_CHANNEL_CACHE);
      for (const d of recent) entries.push({ plane: "channel", channelId, decoded: d });
    }
    saveCache(rt.material.community_id, entries);
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
    this.reconcileChannelSub(rt); // pick up any newly-revealed channels
    // Recompute any open channel views (channel keys may have changed epoch).
    for (const channelId of rt.messages$.keys()) this.recomputeMessages(rt, channelId);
    this.emitCommunities();
  }

  private emitCommunities(): void {
    this.communities$.next([...this.runtimes.values()].map((r) => r.state$.value));
  }

  // ---- CORD-06 rekey read path (adopt a refounding or detect removal) ------

  private scheduleRekeyCheck(rt: Runtime): void {
    if (rt.rekeyTimer) return;
    rt.rekeyTimer = setTimeout(() => {
      rt.rekeyTimer = undefined;
      void this.checkRekey(rt);
    }, 200);
  }

  /**
   * Fold the rekey blobs at the next-epoch base-rekey address (CORD-06 §2/§3):
   * a complete, AUTHORIZED, continuity-checked root rotation carrying our blob
   * means adopt the new root (racing rotations converge on the lowest key); a
   * complete rotation with NO blob for us across all chunks means we've been
   * removed. Authority is the roster (owner or BAN), never key possession — a
   * removed member still holding the prior root can forge a perfect rotation.
   */
  private async checkRekey(rt: Runtime): Promise<void> {
    if (!this.signer.nip44) return;
    const heldEpoch = BigInt(rt.material.root_epoch);
    const heldKey = fromHex(rt.material.community_root);
    const state = rt.state$.value;
    const rolesMap = new Map<string, Role>(state.roles.map((r) => [r.role_id, r]));
    const authorized = (rotator: string): boolean => {
      if (rotator === rt.material.owner) return true;
      return hasPerm(resolveStanding(rotator, rt.material.owner, rolesMap, state.grants).permissions, PERM.BAN);
    };

    const parsed = [...rt.rekeyEvents.values()]
      .map((d) => parseRekey(d))
      .filter((p): p is NonNullable<typeof p> => p !== null);
    const rotations = groupRotations(parsed).filter(
      (set) =>
        set.scopeIdHex === ROOT_SCOPE_HEX &&
        set.newEpoch === heldEpoch + 1n &&
        authorized(set.rotator) &&
        checkContinuity(set, heldEpoch, heldKey).ok,
    );
    if (rotations.length === 0) return;

    const targetEpoch = rt.material.root_epoch + 1;
    if (rt.rekeyHandled.has(targetEpoch)) return;

    let adopted: { key: Uint8Array; rotator: string } | undefined;
    let sawComplete = false;
    for (const set of rotations) {
      if (!set.complete) continue;
      sawComplete = true;
      const blob = findBlob(set, rekeyLocator(set.rotator, this.pubkey, ROOT_SCOPE_HEX, set.newEpoch));
      if (!blob) continue;
      try {
        const plain = await this.signer.nip44.decrypt(set.rotator, blob.wrapped);
        const newKey = decodeWrappedKey(base64ToBytes(plain), new Uint8Array(32), set.newEpoch);
        if (!adopted || lowerKeyWins(adopted.key, newKey) === newKey) adopted = { key: newKey, rotator: set.rotator };
      } catch {
        // undecryptable blob at our locator — treat as absent
      }
    }
    if (!this.runtimes.has(rt.material.community_id)) return; // torn down while awaiting

    if (adopted) {
      rt.rekeyHandled.add(targetEpoch);
      this.adoptRefounding(rt, adopted.key, targetEpoch, adopted.rotator);
    } else if (sawComplete) {
      rt.rekeyHandled.add(targetEpoch);
      this.handleRemoved(rt);
    }
  }

  /**
   * Follow a Refounding forward: roll the runtime to the new root/epoch, keep
   * the prior root in `held_roots` so past history stays decodable, re-derive
   * plane keys, and re-open subscriptions at the new addresses (the old
   * planeMap entries are retained so already-fetched history still decodes).
   */
  private adoptRefounding(rt: Runtime, newRoot: Uint8Array, newEpoch: number, refounder: string): void {
    const priorRoots = Array.isArray(rt.material.held_roots) ? rt.material.held_roots : [];
    rt.material = {
      ...rt.material,
      community_root: toHex(newRoot),
      root_epoch: newEpoch,
      refounder,
      held_roots: [{ epoch: rt.material.root_epoch, key: rt.material.community_root }, ...priorRoots],
    };
    rt.keys = deriveKeys(rt.material, rt.state$.value.channels);
    this.openControlSub(rt); // re-subscribe control/guestbook/dissolved + next rekey at the new epoch
    this.reconcileChannelSub(rt);
    this.refold(rt);
    this.saveMaterialsLocal();
    void this.saveCommunityList();
  }

  /**
   * Initiate a Refounding (CORD-06 §3): roll the community_root to sever the
   * excluded, deliver the new root to `keep` as rekey blobs at the base-rekey
   * address (under the PRIOR root), compact the Control Plane by re-wrapping each
   * head's plaintext seal into the new epoch, seed the new Guestbook with a
   * snapshot, then follow our own rotation forward. Requires BAN or ownership +
   * a NIP-44 signer (pairwise wrapping is one ECDH either side can compute).
   */
  async refound(cid: string, opts: { keep: string[]; exclude?: string[] }): Promise<void> {
    const rt = this.runtimes.get(cid);
    if (!rt) throw new Error("unknown community");
    if (!this.signer.nip44) throw new Error("this signer can't rotate keys (NIP-44 unsupported)");
    const state = rt.state$.value;
    const rolesMap = new Map<string, Role>(state.roles.map((r) => [r.role_id, r]));
    const s = resolveStanding(this.pubkey, rt.material.owner, rolesMap, state.grants);
    if (!s.isOwner && !hasPerm(s.permissions, PERM.BAN)) throw new Error("need BAN or ownership to refound");

    const excluded = new Set(opts.exclude ?? []);
    const recipients = [...new Set([this.pubkey, ...opts.keep])].filter((pk) => !excluded.has(pk));
    const oldRoot = fromHex(rt.material.community_root);
    const oldEpoch = rt.material.root_epoch;
    const newEpoch = oldEpoch + 1;
    const cidBytes = fromHex(rt.material.community_id);
    const newRoot = generateSecretKey();
    const prevCommit = toHex(epochKeyCommitment(oldEpoch, oldRoot));
    const relays = this.relaysFor(rt);

    // 1. The root roll: per-recipient rekey blobs at the base-rekey address
    //    (keyed by the PRIOR root, so every current holder converges).
    const plain = bytesToBase64(encodeWrappedKey(ZERO_32, BigInt(newEpoch), newRoot));
    const blobs = [];
    for (const pk of recipients) {
      const wrapped = await this.signer.nip44.encrypt(pk, plain);
      blobs.push({ locator: rekeyLocator(this.pubkey, pk, ROOT_SCOPE_HEX, BigInt(newEpoch)), wrapped });
    }
    const rekeyAddr = baseRekeyGroupKey(oldRoot, cidBytes, newEpoch);
    for (const rumor of buildRekeyRumors(
      { scope: { kind: "root" }, newEpoch: BigInt(newEpoch), prevEpoch: BigInt(oldEpoch), prevCommit },
      blobs,
    )) {
      const { wrap } = await createStreamEvent({ streamSk: rekeyAddr.sk, convKey: rekeyAddr.convKey, author: this.signer, rumor });
      await pool.publish(relays, wrap).catch((err) => console.warn("rekey publish failed", err));
    }

    // 2. Compaction: re-wrap each Control-Plane head's plaintext seal into the
    //    new epoch so members read current state without re-syncing from genesis.
    const newControl = controlGroupKey(newRoot, cidBytes, newEpoch);
    for (const head of state.heads?.values() ?? []) {
      if (!head.seal || head.sealKind !== KIND.SEAL_PLAINTEXT) continue;
      try {
        pool.publish(relays, rewrapSeal(head.seal, newControl.sk, newControl.convKey)).catch(() => {});
      } catch {
        /* an encrypted-seal head can't re-wrap; control heads are plaintext by construction */
      }
    }

    // 3. Guestbook snapshot (best-effort, non-gating — CORD-02 §5).
    const newGuestbook = guestbookGroupKey(newRoot, cidBytes, newEpoch);
    for (const rumor of buildSnapshotRumors(recipients, toHex(generateSecretKey()))) {
      const { wrap } = await createStreamEvent({ streamSk: newGuestbook.sk, convKey: newGuestbook.convKey, author: this.signer, rumor });
      pool.publish(relays, wrap).catch(() => {});
    }

    // 4. Follow our own rotation forward.
    rt.rekeyHandled.add(newEpoch);
    this.adoptRefounding(rt, newRoot, newEpoch, this.pubkey);
  }

  /**
   * Force a community-wide epoch rotation (a no-exclude Refounding) — useful
   * for testing the CORD-06 rotation path. Rolls `community_root` forward,
   * re-keys every channel and voice room, and triggers a brief re-sync for
   * other members. Same gate as `refound`: ownership or BAN.
   */
  async rekey(cid: string): Promise<void> {
    const rt = this.runtimes.get(cid);
    if (!rt) throw new Error("unknown community");
    const members = [...rt.state$.value.members];
    await this.refound(cid, { keep: members, exclude: [] });
  }

  /** We were excluded from a Refounding: tombstone the membership and tear down. */
  private handleRemoved(rt: Runtime): void {
    const cid = rt.material.community_id;
    rt.controlSub?.unsubscribe();
    rt.channelSub?.unsubscribe();
    if (rt.persistTimer) clearTimeout(rt.persistTimer);
    if (rt.refoldTimer) clearTimeout(rt.refoldTimer);
    if (rt.rekeyTimer) clearTimeout(rt.rekeyTimer);
    clearCache(cid);
    this.runtimes.delete(cid);
    this.communityList = removeFromList(this.communityList, cid, Date.now());
    this.saveCommunityListLocal();
    this.saveMaterialsLocal();
    this.emitCommunities();
    void this.saveCommunityList();
  }

  // ---- message assembly ---------------------------------------------------

  private recomputeMessages(rt: Runtime, channelId: string): void {
    const subj = rt.messages$.get(channelId);
    if (!subj) return;
    const events = rt.channelEvents.get(channelId);
    const byId = new Map<string, ChatMessage>();
    // target -> reaction content -> { url?, authors }. A custom emoji reaction's
    // content is `:shortcode:` and carries the image URL from its own emoji tag.
    const reactions = new Map<string, Map<string, { url?: string; authors: Set<string> }>>();
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
            attachments: [...parseImeta(r.tags).values()],
            emojiTags: r.tags.filter((t) => t[0] === "emoji"),
            raw: d,
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
          let entry = emap.get(r.content);
          if (!entry) {
            // NIP-30: resolve a custom `:shortcode:` reaction to its image URL
            // via applesauce (plain unicode reactions resolve to undefined).
            const custom = getReactionEmoji(r as unknown as NostrEvent);
            entry = { url: custom?.url, authors: new Set() };
            emap.set(r.content, entry);
          }
          entry.authors.add(d.author);
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
      msg.reactions = [...emap.entries()].map(([emoji, { url, authors }]) => ({
        emoji,
        url,
        count: authors.size,
        authors: [...authors],
      }));
    }

    subj.next([...byId.values()].sort((a, b) => a.ms - b.ms));
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
      const newest = events.sort((a, b) => b.created_at - a.created_at)[0];
      if (!newest || !this.signer.nip44) return;
      // Decrypt through applesauce's encrypted-content cache: the plaintext is
      // memoised on the (deduped) stored event, so a re-fold, StrictMode double
      // mount, or another client instance won't re-prompt the signer.
      eventStore.add(newest);
      const latest = eventStore.getReplaceable(KIND.COMMUNITY_LIST, this.pubkey) ?? newest;
      if (!isEncryptedContentUnlocked(latest)) {
        await unlockEncryptedContent(latest, this.pubkey, this.signer);
      }
      const json = getEncryptedContent(latest);
      if (!json) return;
      const remote = JSON.parse(json) as CommunityList;
      // Merge into our document rather than replace — preserves tombstones,
      // other-device entries, and lowest-epoch seeds (CORD-02 §8).
      this.communityList = mergeCommunityLists(this.communityList, remote);
      // Persist the merged document locally so tombstones learned from the
      // relay survive a later offline reload (CORD-02 §8).
      this.saveCommunityListLocal();
      // Liveness is DERIVED, not "present in tombstones": a leave-then-rejoin
      // (added_at > removed_at) legitimately resurrects, so a blanket tombstone
      // drop would wrongly hide re-joined communities and diverge from armada.
      for (const entry of this.communityList.entries) {
        const m = entry.current;
        if (!m?.community_id || !isCommunityLive(this.communityList, m.community_id)) continue;
        if (!this.runtimes.has(m.community_id)) this.addRuntime(m);
      }
      // Safety net: tear down any runtime whose community is no longer live
      // after the merge (e.g. materials existed locally but the tombstone was
      // only learned from the relay). A rejoin resurrects via the add loop.
      for (const cid of [...this.runtimes.keys()]) {
        if (!isCommunityLive(this.communityList, cid)) {
          const rt = this.runtimes.get(cid)!;
          rt.controlSub?.unsubscribe();
          rt.channelSub?.unsubscribe();
          if (rt.persistTimer) clearTimeout(rt.persistTimer);
          if (rt.refoldTimer) clearTimeout(rt.refoldTimer);
          if (rt.rekeyTimer) clearTimeout(rt.rekeyTimer);
          clearCache(cid);
          this.runtimes.delete(cid);
        }
      }
      this.saveMaterialsLocal();
      this.emitCommunities();
    } catch (err) {
      console.warn("failed to load community list", err);
    }
  }

  private async saveCommunityList(): Promise<void> {
    // Always persist locally first — even without nip44 (extension signing)
    // the tombstone must survive a reload so a left community stays gone.
    this.saveCommunityListLocal();
    if (!this.signer.nip44) return;
    try {
      // Reconcile the merged document with the live runtimes: add new joins,
      // refresh the `current` snapshot for local material changes (a fresh
      // channel key, a rename), and resurrect a re-joined tombstoned community
      // by bumping its add past the removal. Tombstones + other-device entries
      // are preserved (CORD-02 §8), never clobbered.
      const nowMs = Date.now();
      let list = this.communityList;
      for (const rt of this.runtimes.values()) {
        const cid = rt.material.community_id;
        const existing = list.entries.find((e) => e.community_id === cid);
        if (!existing) {
          list = addToList(list, { community_id: cid, seed: rt.material, current: rt.material, added_at: nowMs });
          continue;
        }
        list = refreshCurrent(list, rt.material);
        const tomb = list.tombstones.find((t) => t.community_id === cid);
        if (tomb && existing.added_at <= tomb.removed_at) {
          list = addToList(list, { ...existing, current: rt.material, added_at: nowMs });
        }
      }
      this.communityList = list;
      if (!withinByteCap(list)) {
        console.warn("community list exceeds the NIP-44 byte cap; not publishing");
        return;
      }
      const plaintext = JSON.stringify(list);
      const content = await this.signer.nip44.encrypt(this.pubkey, plaintext);
      const signed = await this.signer.signEvent({
        kind: KIND.COMMUNITY_LIST,
        content,
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
      });
      eventStore.add(signed);
      const stored = eventStore.getReplaceable(KIND.COMMUNITY_LIST, this.pubkey) ?? signed;
      // Seed the decryption cache with what we just encrypted, so re-reading our
      // own freshly-published list never round-trips the signer again.
      setEncryptedContentCache(stored, plaintext);
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
