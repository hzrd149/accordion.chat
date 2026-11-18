// A local, incrementally maintained fuzzy index over a set of users (a
// community's members). It holds one profile subscription per user, applies
// changes to a single Fuse instance in place, and coalesces bursts (e.g. N
// profiles loading at startup) into one flush. `search` is synchronous and never
// touches the network; the app's network fallback is Open Ranking, used only to
// find people outside the community.

import Fuse, { type IFuseOptions } from "fuse.js";
import { BehaviorSubject, type Observable, type Subscription } from "rxjs";
import { nip19 } from "nostr-tools";
import { shortNpub } from "./util";

export interface UserSearchEntry {
  pubkey: string;
  npub: string;
  /** Display name once the kind-0 profile loads, else a short npub. */
  name: string;
  displayName?: string;
  username?: string;
  nip05?: string;
  picture?: string;
}

/** The profile fields the index reads, or undefined while no profile is known. */
export interface UserSearchProfile {
  displayName?: string;
  name?: string;
  nip05?: string;
  picture?: string;
}

export interface UserSearchOptions {
  limit?: number;
  exclude?: Iterable<string>;
}

const DEFAULT_LIMIT = 8;
const REBUILD_THRESHOLD = 32;

const FUSE_OPTIONS: IFuseOptions<UserSearchEntry> = {
  keys: [
    { name: "displayName", weight: 3 },
    { name: "username", weight: 2 },
    { name: "nip05", weight: 1.5 },
    { name: "npub", weight: 1 },
  ],
  threshold: 0.4,
  ignoreLocation: true,
};

/** Decode a pasted hex pubkey, npub or nprofile; null for anything else. */
export function parsePubkey(input: string): string | null {
  const q = input.trim();
  if (/^[0-9a-f]{64}$/i.test(q)) return q.toLowerCase();
  try {
    const decoded = nip19.decode(q);
    if (decoded.type === "npub") return decoded.data;
    if (decoded.type === "nprofile") return decoded.data.pubkey;
  } catch {
    return null;
  }
  return null;
}

function toEntry(pubkey: string, npub: string, profile: UserSearchProfile | undefined): UserSearchEntry {
  const displayName = profile?.displayName || profile?.name || undefined;
  return {
    pubkey,
    npub,
    name: displayName || shortNpub(pubkey),
    displayName,
    username: profile?.name || undefined,
    nip05: profile?.nip05 || undefined,
    picture: profile?.picture || undefined,
  };
}

const byName = (a: UserSearchEntry, b: UserSearchEntry) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.pubkey.localeCompare(b.pubkey);

export class UserSearchIndex {
  /** Bumped once per flush; subscribe to re-run searches. */
  readonly version$ = new BehaviorSubject(0);

  private readonly entries = new Map<string, UserSearchEntry>();
  private readonly profileSubs = new Map<string, { sub: Subscription | null }>();
  private readonly fuse = new Fuse<UserSearchEntry>([], FUSE_OPTIONS);
  private readonly pending = new Map<string, UserSearchEntry | null>();
  private sorted: UserSearchEntry[] | null = [];
  private flushScheduled = false;
  private disposed = false;
  private readonly membersSub: Subscription;
  private readonly profile$: (pubkey: string) => Observable<UserSearchProfile | undefined>;

  constructor(
    members$: Observable<ReadonlySet<string> | Iterable<string>>,
    profile$: (pubkey: string) => Observable<UserSearchProfile | undefined>,
  ) {
    this.profile$ = profile$;
    this.membersSub = members$.subscribe((members) => this.syncMembers(new Set(members)));
  }

  /** Fuzzy search; an empty query lists users by name, a pasted pubkey/npub matches exactly. */
  search(query: string, opts: UserSearchOptions = {}): UserSearchEntry[] {
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const exclude = opts.exclude ? new Set(opts.exclude) : null;
    const keep = (e: UserSearchEntry) => !exclude?.has(e.pubkey);
    const q = query.trim();
    if (!q) return this.list().filter(keep).slice(0, limit);

    const exact = parsePubkey(q);
    if (exact) {
      const entry = this.entries.get(exact);
      return entry && keep(entry) ? [entry] : [];
    }
    // Over-fetch when excluding so filtered rows don't shrink the result below `limit`.
    const fetch = exclude ? limit + exclude.size : limit;
    return this.fuse.search(q, { limit: fetch }).map((r) => r.item).filter(keep).slice(0, limit);
  }

  /** Every indexed user, sorted by name. */
  list(): UserSearchEntry[] {
    if (!this.sorted) this.sorted = [...this.entries.values()].sort(byName);
    return this.sorted;
  }

  get(pubkey: string): UserSearchEntry | undefined {
    return this.entries.get(pubkey);
  }

  get size(): number {
    return this.entries.size;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.membersSub.unsubscribe();
    for (const slot of this.profileSubs.values()) slot.sub?.unsubscribe();
    this.profileSubs.clear();
    this.pending.clear();
    this.version$.complete();
  }

  private syncMembers(next: Set<string>) {
    if (this.disposed) return;
    for (const pubkey of [...this.profileSubs.keys()]) {
      if (next.has(pubkey)) continue;
      this.profileSubs.get(pubkey)?.sub?.unsubscribe();
      this.profileSubs.delete(pubkey);
      this.queue(pubkey, null);
    }
    for (const pubkey of next) {
      if (this.profileSubs.has(pubkey)) continue;
      let npub: string;
      try {
        npub = nip19.npubEncode(pubkey);
      } catch {
        continue; // not a valid hex pubkey
      }
      // Searchable by npub immediately; the profile upgrades the entry in place.
      this.queue(pubkey, toEntry(pubkey, npub, undefined));
      // Record the slot before subscribing so a cached profile emitted synchronously
      // isn't mistaken for a callback from an already-removed member.
      const slot = { sub: null as Subscription | null };
      this.profileSubs.set(pubkey, slot);
      slot.sub = this.profile$(pubkey).subscribe((profile) => {
        if (this.profileSubs.get(pubkey) === slot) this.queue(pubkey, toEntry(pubkey, npub, profile));
      });
      if (this.profileSubs.get(pubkey) !== slot) slot.sub.unsubscribe();
    }
  }

  private queue(pubkey: string, entry: UserSearchEntry | null) {
    this.pending.set(pubkey, entry);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush() {
    this.flushScheduled = false;
    if (this.disposed || this.pending.size === 0) return;
    // Small batches update Fuse in place; a large burst (startup profile loads)
    // is cheaper as one rebuild than as many O(n) removals.
    const rebuild = this.pending.size > REBUILD_THRESHOLD;
    let changed = false;
    for (const [pubkey, entry] of this.pending) {
      const prev = this.entries.get(pubkey);
      if (entry === null) {
        if (!prev) continue;
        this.entries.delete(pubkey);
        if (!rebuild) this.fuse.remove((e) => e.pubkey === pubkey);
        changed = true;
        continue;
      }
      if (prev && sameEntry(prev, entry)) continue;
      if (prev && !rebuild) this.fuse.remove((e) => e.pubkey === pubkey);
      this.entries.set(pubkey, entry);
      if (!rebuild) this.fuse.add(entry);
      changed = true;
    }
    if (rebuild && changed) this.fuse.setCollection([...this.entries.values()]);
    this.pending.clear();
    if (!changed) return;
    this.sorted = null;
    this.version$.next(this.version$.value + 1);
  }
}

function sameEntry(a: UserSearchEntry, b: UserSearchEntry): boolean {
  return a.name === b.name && a.displayName === b.displayName && a.username === b.username &&
    a.nip05 === b.nip05 && a.picture === b.picture;
}
