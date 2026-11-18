// @-mention support for the composer. Candidates come from the community's
// shared local search index (`services/user-search.ts`); selecting one inserts
// a `nostr:npub…` link into the draft — the chat rumor builder (`messageRumor`)
// turns that into the NIP-C7 `p` tag automatically.

import type { UserSearchEntry } from "../helpers/user-search";

export type MentionCandidate = UserSearchEntry;

/**
 * If the caret sits inside an `@token` (a `@` at word start with no whitespace up
 * to the caret), return the query text after the `@` and the `@`'s index. The
 * token ends at the first whitespace, so a completed word closes the menu.
 */
export function detectMention(value: string, caret: number): { query: string; start: number } | null {
  const upto = value.slice(0, caret);
  const m = /(?:^|\s)@(\S*)$/.exec(upto);
  if (!m) return null;
  return { query: m[1], start: caret - m[1].length - 1 };
}
