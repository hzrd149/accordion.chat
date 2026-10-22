// The app-side CORD-07 voice runtime, per community.
//
// applesauce-concord derives the CORD-07 keys (`voiceKeysFor`) and routes kind-23313
// presence rumors into the channel's own plane store — its receive funnel decodes the
// ephemeral (21059) wrap and applies the CORD-03 channel/epoch binding check before
// storing. So this engine runs no subscription of its own: it reads presence straight
// off `community.channelStore(id)` and owns only what the package leaves to the client
// — the presence fold, the heartbeat, and the join/leave lifecycle.
//
// Publishing goes through `community.sendEvent(..., {ephemeral})`, whose local echo the
// community's publish path skips for ephemeral wraps — so we self-reflect our own
// presence into the fold directly, which is our only source for our own roster tile.

import { BehaviorSubject, Subscription } from "rxjs";
import type { ConcordCommunity } from "@applesauce/concord";
import type { ChannelMetadata } from "@applesauce/concord";
import { voiceKeysFor, VOICE_PRESENCE_KIND, type VoiceKeys } from "@applesauce/concord/helpers";
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

  /**
   * The voice keys (SFU room + media root) for a channel. Every channel is
   * voice-capable, so `null` means we cannot *derive* them: either the channel
   * isn't folded yet, or it's private and `material.channels` holds no key for it
   * (CHAN-01 — a keyless private channel derives nothing rather than falling back
   * to the public root address). Callers should surface that, not no-op silently.
   */
  voiceKeys(channelId: string): VoiceKeys | null {
    const ch = this.channel(channelId);
    if (!ch) return null;
    return voiceKeysFor(this.community.material, ch);
  }

  /** The folded call-presence view for a channel (CORD-07 §4). Lazily opens the
   *  read off the channel's plane store on first use. */
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

  /**
   * Read presence off the channel's own plane store. The package's receive funnel
   * has already decoded the ephemeral wrap under the channel's conv key and applied
   * the CORD-03 channel/epoch binding check, so a replayed prior-epoch ping never
   * reaches us — all that's left is the presence shape and the fold.
   */
  private openPresenceSub(channelId: string): void {
    const sub = this.community
      .channelStore(channelId)
      .timeline([{ kinds: [VOICE_PRESENCE_KIND] }])
      .subscribe((rumors) => {
        let changed = false;
        for (const rumor of rumors) {
          const entry = parsePresence(rumor);
          if (entry && this.accept(channelId, entry)) changed = true;
        }
        if (changed) this.recompute(channelId);
      });
    this.subs.set(channelId, sub);
  }

  /** Accept one entry into the per-channel latest-wins map. Returns whether it
   *  displaced what was there, so batch callers can recompute exactly once. */
  private accept(channelId: string, entry: VoicePresenceEntry): boolean {
    // Reject far-future stamps so a forged date can't squat "latest".
    if (entry.ms > Date.now() + 60_000) return false;
    let byAuthor = this.entries.get(channelId);
    if (!byAuthor) {
      byAuthor = new Map();
      this.entries.set(channelId, byAuthor);
    }
    const prev = byAuthor.get(entry.author);
    // Latest wins (ms basis, rumor-id tiebreak) — a replayed older ping loses.
    if (prev && !(entry.ms > prev.ms || (entry.ms === prev.ms && entry.rumorId < prev.rumorId))) return false;
    byAuthor.set(entry.author, entry);
    return true;
  }

  private ingestEntry(channelId: string, entry: VoicePresenceEntry): void {
    if (this.accept(channelId, entry)) this.recompute(channelId);
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
