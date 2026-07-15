import { useCallback, useMemo, useState } from "react";
import { use$ } from "applesauce-react/hooks";
import { castUser } from "applesauce-common/casts";
import { mapEventsToStore, mapEventsToTimeline } from "applesauce-core/observable";
import { catchError, EMPTY, lastValueFrom, merge, of } from "rxjs";
import type { NostrEvent } from "nostr-tools";
import { eventStore, LOOKUP_RELAYS, pool, user$ } from "../nostr";
import {
  ACTIVE_PROFILE_THEME_KIND,
  parseProfileThemeEvent,
  PROFILE_THEME_KIND,
  profileThemeAddress,
  type ProfileTheme,
} from "../lib/profile-theme";

const MAX_THEME_CONTACTS = 200;
const OUTBOX_TIMEOUT_MS = 2000;
const NO_EVENTS: NostrEvent[] = [];

export type ProfileThemesState = {
  themes: ProfileTheme[];
  authors: string[];
  fetching: boolean;
  error: string | null;
  fetchThemes: () => Promise<void>;
};

function contactPubkey(contact: unknown): string | null {
  if (typeof contact === "string") return contact;
  if (contact && typeof contact === "object" && typeof (contact as { pubkey?: unknown }).pubkey === "string") {
    return (contact as { pubkey: string }).pubkey;
  }
  return null;
}

function newestByAddress(events: NostrEvent[]): NostrEvent[] {
  const map = new Map<string, NostrEvent>();
  for (const event of events) {
    const address = profileThemeAddress(event);
    if (!address) continue;
    const previous = map.get(address);
    if (!previous || previous.created_at < event.created_at) map.set(address, event);
  }
  return [...map.values()];
}

async function buildRelayGroups(authors: string[]): Promise<Array<[string, string[]]>> {
  const groups = new Map<string, Set<string>>();

  await Promise.all(
    authors.map(async (author) => {
      const outboxes = (await castUser(author, eventStore).outboxes$.$first(OUTBOX_TIMEOUT_MS, [])) ?? [];
      const relays = outboxes.length ? outboxes : LOOKUP_RELAYS;
      for (const relay of relays) {
        const set = groups.get(relay) ?? new Set<string>();
        set.add(author);
        groups.set(relay, set);
      }
    }),
  );

  return [...groups.entries()].map(([relay, set]) => [relay, [...set]]);
}

export function useAvailableProfileThemes(pubkey: string | undefined): ProfileThemesState {
  const activeUser = use$(user$);
  const user = activeUser ?? (pubkey ? castUser(pubkey, eventStore) : undefined);
  const contacts = use$(() => user?.contacts$, [user]);
  const [fetching, setFetching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authors = useMemo(() => {
    if (!pubkey) return [];
    const contactKeys = ((contacts as unknown[] | undefined) ?? [])
      .map(contactPubkey)
      .filter((key): key is string => Boolean(key))
      .slice(0, MAX_THEME_CONTACTS);
    return [...new Set([pubkey, ...contactKeys])];
  }, [pubkey, contacts]);
  const authorsKey = authors.join(",");

  const events = use$(
    () =>
      authors.length
        ? eventStore.timeline([{ kinds: [PROFILE_THEME_KIND, ACTIVE_PROFILE_THEME_KIND], authors }])
        : of([] as NostrEvent[]),
    [authorsKey],
  ) ?? NO_EVENTS;

  const themes = useMemo(
    () =>
      newestByAddress(events)
        .map(parseProfileThemeEvent)
        .filter((theme): theme is ProfileTheme => Boolean(theme))
        .sort((a, b) => a.title.localeCompare(b.title)),
    [events],
  );

  const fetchThemes = useCallback(async () => {
    const currentAuthors = authorsKey ? authorsKey.split(",") : [];
    if (!currentAuthors.length || fetching) return;
    setFetching(true);
    setError(null);
    try {
      const groups = await buildRelayGroups(currentAuthors);
      if (!groups.length) return;
      await lastValueFrom(
        merge(
          ...groups.map(([relay, groupAuthors]) =>
            pool
              .request([relay], [{ kinds: [PROFILE_THEME_KIND, ACTIVE_PROFILE_THEME_KIND], authors: groupAuthors }])
              .pipe(mapEventsToStore(eventStore), catchError(() => EMPTY)),
          ),
        ).pipe(mapEventsToTimeline()),
        { defaultValue: [] as NostrEvent[] },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch Nostr themes");
    } finally {
      setFetching(false);
    }
  }, [authorsKey, fetching]);

  return { themes, authors, fetching, error, fetchThemes };
}
