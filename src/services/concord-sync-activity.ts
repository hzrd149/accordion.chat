import type { ConcordClient, ConcordCommunity, ConcordDiagnostic } from "@applesauce/concord";
import { auditTime, BehaviorSubject, distinctUntilChanged, map, merge, Subject, switchMap } from "rxjs";

const HISTORY = 20;

interface SyncEvent {
  id: string;
  kind: number;
  source: string;
  observedAt: number;
}

interface SyncActivity {
  events: readonly SyncEvent[];
  issues: readonly ConcordDiagnostic[];
}

const EMPTY: SyncActivity = { events: [], issues: [] };
const journals = new WeakMap<ConcordClient, BehaviorSubject<ReadonlyMap<string, SyncActivity>>>();
function journalFor(client: ConcordClient) {
  let journal = journals.get(client);
  if (!journal) {
    journal = new BehaviorSubject<ReadonlyMap<string, SyncActivity>>(new Map());
    journals.set(client, journal);
  }
  return journal;
}
const sameItems = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

function communityEvents(community: ConcordCommunity) {
  const fromStore = (store: ConcordCommunity["controlStore"], source: string) =>
    store.insert$.pipe(map(({ id, kind }): SyncEvent => ({ id, kind, source, observedAt: Date.now() })));

  return merge(
    fromStore(community.controlStore, "Control"),
    fromStore(community.rumorStore, "Public channels"),
    community.epoch$.pipe(switchMap(() => fromStore(community.guestbookStore, "Membership"))),
    community.privateChannelStatus$.pipe(
      map((channels) => [...channels.keys()]),
      distinctUntilChanged(sameItems),
      switchMap((ids) => merge(...ids.map((id) => fromStore(community.channelStore(id), id)))),
    ),
  );
}

export function syncActivity$(client: ConcordClient, communityId = "") {
  return journalFor(client).pipe(
    map((journal) => journal.get(communityId) ?? EMPTY),
    distinctUntilChanged(),
  );
}

/** Keep a small, metadata-only journal from startup, even while the page is closed. */
export function observeConcordSync(client: ConcordClient) {
  const journal = journalFor(client);
  const updates = new Subject<void>();
  const entries = new Map<string, SyncActivity>();
  const subscription = updates.pipe(auditTime(150)).subscribe(() => journal.next(new Map(entries)));

  subscription.add(client.diagnostics$.subscribe((issue) => {
    const id = issue.communityId ?? "";
    const current = entries.get(id) ?? EMPTY;
    entries.set(id, { ...current, issues: [issue, ...current.issues.slice(0, HISTORY - 1)] });
    updates.next();
  }));

  subscription.add(client.communities$.pipe(
    map((states) => states.flatMap(({ material }) => client.getCommunity(material.community_id) ?? [])),
    distinctUntilChanged(sameItems),
    switchMap((communities) => {
      const activeIds = new Set(communities.map(({ material }) => material.community_id));
      for (const id of entries.keys()) {
        if (id && !activeIds.has(id)) entries.delete(id);
      }
      updates.next();
      return merge(...communities.map((community) => {
        const communityId = community.material.community_id;
        return communityEvents(community).pipe(map((event) => ({ communityId, event })));
      }));
    }),
  ).subscribe(({ communityId, event }) => {
    const current = entries.get(communityId) ?? EMPTY;
    entries.set(communityId, { ...current, events: [event, ...current.events.slice(0, HISTORY - 1)] });
    updates.next();
  }));

  return () => {
    subscription.unsubscribe();
    journal.complete();
    journals.delete(client);
  };
}
