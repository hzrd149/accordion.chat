// The app-side CORD-07 voice runtime, per community.
//
// applesauce-concord's ConcordCommunity deliberately drops voice-presence rumors
// at ingest, so this engine reimplements the four voice methods the old monolithic
// client carried: `voiceKeys`, `getVoicePresence$`, `joinVoice`, `leaveVoice`.
//
// Presence rides the Channel's own Chat-Plane key (§4): we run our own ephemeral
// (21059) subscription at the channel address and decode with its conv key. That
// subscription piggy-backs the pool socket the manager's ConcordRelayAuth already
// NIP-42-authenticates for this channel's stream key (`waitForAuth` holds the REQ
// until it is). Publishing goes through `community.sendEvent(..., {ephemeral})`,
// whose local echo the community's voice filter swallows — so we self-reflect our
// own presence into the fold directly.

import { BehaviorSubject, Subscription } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import type { ConcordCommunity } from "applesauce-concord";
import type { ChannelMetadata, JoinMaterial } from "applesauce-concord";
import {
  channelKeyFor,
  voiceKeysFor,
  decodeWrapCached,
  checkChatBinding,
  EPHEMERAL_GIFT_WRAP_KIND,
  VOICE_PRESENCE_KIND,
  STOCK_RELAYS,
  type VoiceKeys,
} from "applesauce-concord/helpers";
import { pool } from "../nostr";
import {
  foldVoicePresence,
  parsePresence,
  presenceTags,
  VOICE_HEARTBEAT_MS,
  VOICE_STALE_MS,
  type VoicePresenceEntry,
  type VoicePresenceFold,
} from "./presence";

const EMPTY_FOLD: VoicePresenceFold = { present: [], claims: new Map() };

/** The Chat-Plane epoch a channel's rumors bind to (mirrors the package's
 *  internal `channelSecret`: private channels carry their own key+epoch). */
function channelEpoch(material: JoinMaterial, channel: ChannelMetadata): number {
  return channel.private && channel.key ? (channel.epoch ?? 1) : material.root_epoch;
}

export class VoiceEngine {
  private readonly presence$ = new Map<string, BehaviorSubject<VoicePresenceFold>>();
  private readonly entries = new Map<string, Map<string, VoicePresenceEntry>>();
  private readonly subs = new Map<string, Subscription>();
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>();
  private decay?: ReturnType<typeof setInterval>;
  private readonly community: ConcordCommunity;

  constructor(community: ConcordCommunity) {
    this.community = community;
  }

  private channel(channelId: string): ChannelMetadata | undefined {
    return this.community.state$.value.channels.find((c) => c.channel_id === channelId);
  }

  /** The voice keys (SFU room + media root) for a channel, or undefined if the
   *  channel isn't a voice channel or isn't known. */
  voiceKeys(channelId: string): VoiceKeys | undefined {
    const ch = this.channel(channelId);
    if (!ch?.voice) return undefined;
    return voiceKeysFor(this.community.material, ch);
  }

  /** The folded call-presence view for a voice channel (CORD-07 §4). Lazily opens
   *  the presence subscription on first read. */
  getVoicePresence$(channelId: string): BehaviorSubject<VoicePresenceFold> {
    let subj = this.presence$.get(channelId);
    if (!subj) {
      subj = new BehaviorSubject<VoicePresenceFold>(EMPTY_FOLD);
      this.presence$.set(channelId, subj);
      this.openPresenceSub(channelId);
      this.ensureDecay();
    }
    return subj;
  }

  private relays(): string[] {
    const r = this.community.material.relays;
    return r.length ? r : STOCK_RELAYS;
  }

  /** Subscribe to the channel's ephemeral (21059) wraps and fold the presence
   *  rumors they carry. Decode succeeds only under the current epoch's conv key,
   *  so a replayed prior-epoch ping can't decode — the explicit binding check is
   *  defense in depth. */
  private openPresenceSub(channelId: string): void {
    const ch = this.channel(channelId);
    if (!ch) return;
    const key = channelKeyFor(this.community.material, ch);
    const epoch = channelEpoch(this.community.material, ch);
    const sub = pool
      .subscription(this.relays(), [{ kinds: [EPHEMERAL_GIFT_WRAP_KIND], authors: [key.pk] }], {
        waitForAuth: [key.pk],
      })
      .subscribe((event) => {
        if (typeof event === "string") return; // EOSE marker
        const decoded = decodeWrapCached(event as NostrEvent, key.convKey);
        if (!decoded || decoded.rumor.kind !== VOICE_PRESENCE_KIND) return;
        if (!checkChatBinding(decoded.rumor.tags, channelId, epoch)) return;
        const entry = parsePresence(decoded);
        if (entry) this.ingestEntry(channelId, entry);
      });
    this.subs.set(channelId, sub);
  }

  private ingestEntry(channelId: string, entry: VoicePresenceEntry): void {
    // Reject far-future stamps so a forged date can't squat "latest".
    if (entry.ms > Date.now() + 60_000) return;
    let byAuthor = this.entries.get(channelId);
    if (!byAuthor) {
      byAuthor = new Map();
      this.entries.set(channelId, byAuthor);
    }
    const prev = byAuthor.get(entry.author);
    // Latest wins (ms basis, rumor-id tiebreak) — a replayed older ping loses.
    if (prev && !(entry.ms > prev.ms || (entry.ms === prev.ms && entry.rumorId < prev.rumorId))) return;
    byAuthor.set(entry.author, entry);
    this.recompute(channelId);
  }

  private recompute(channelId: string): void {
    const subj = this.presence$.get(channelId);
    if (!subj) return;
    const now = Date.now();
    const byAuthor = this.entries.get(channelId);
    if (byAuthor) {
      // Prune long-stale entries so the map stays bounded; anything a pruned
      // entry could out-rank is even older, so this never resurrects one.
      for (const [author, e] of byAuthor) if (now - e.ms > VOICE_STALE_MS) byAuthor.delete(author);
    }
    subj.next(foldVoicePresence(byAuthor ? [...byAuthor.values()] : [], now));
  }

  /** One shared decay ticker re-folds every open call so a participant who stops
   *  heartbeating ages out even with no new events. */
  private ensureDecay(): void {
    if (this.decay) return;
    this.decay = setInterval(() => {
      for (const channelId of this.presence$.keys()) this.recompute(channelId);
    }, VOICE_STALE_MS / 6);
  }

  /**
   * Announce joining a call (§4): publish a `joined` (carrying the broker-assigned
   * SFU identity + broker rendezvous hint) now and every 30s. Idempotent per
   * channel — re-joining replaces the prior heartbeat.
   */
  async joinVoice(channelId: string, identity: string, broker: string): Promise<void> {
    this.getVoicePresence$(channelId); // ensure the fold subject + decay exist
    this.stopHeartbeat(channelId);
    const beat = () => void this.publishPresence(channelId, "joined", identity, broker);
    beat();
    this.heartbeats.set(channelId, setInterval(beat, VOICE_HEARTBEAT_MS));
  }

  /** Announce leaving a call (§4): best-effort `left`; a missed one heals by
   *  staleness. Stops our heartbeat. */
  async leaveVoice(channelId: string): Promise<void> {
    if (!this.heartbeats.has(channelId)) return;
    this.stopHeartbeat(channelId);
    await this.publishPresence(channelId, "left");
  }

  private stopHeartbeat(channelId: string): void {
    const timer = this.heartbeats.get(channelId);
    if (timer) {
      clearInterval(timer);
      this.heartbeats.delete(channelId);
    }
  }

  /** Publish one presence rumor over the channel's own address (ephemeral wrap)
   *  and reflect it locally so our own roster tile appears immediately — the
   *  community drops its own voice echo, so this self-reflection is our only
   *  source for our own tile. */
  private async publishPresence(
    channelId: string,
    status: "joined" | "left",
    identity?: string,
    broker?: string,
  ): Promise<void> {
    const template = {
      kind: VOICE_PRESENCE_KIND,
      content: status,
      created_at: Math.floor(Date.now() / 1000),
      tags: presenceTags(status, identity, broker),
    };
    // sendEvent binds channel/epoch/ms and publishes the ephemeral (21059) wrap.
    const rumorId = await this.community.sendEvent(channelId, template, { ephemeral: true });
    this.ingestEntry(channelId, {
      author: this.community.pubkey,
      status,
      identity,
      broker,
      ms: Date.now(),
      rumorId,
    });
  }

  dispose(): void {
    for (const sub of this.subs.values()) sub.unsubscribe();
    this.subs.clear();
    for (const timer of this.heartbeats.values()) clearInterval(timer);
    this.heartbeats.clear();
    if (this.decay) clearInterval(this.decay);
    this.decay = undefined;
    this.presence$.clear();
    this.entries.clear();
  }
}
