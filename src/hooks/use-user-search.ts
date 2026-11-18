import { useCallback, useMemo } from "react";
import { use$ } from "applesauce-react/hooks";
import type { ConcordCommunity } from "@applesauce/concord";
import type { UserSearchEntry, UserSearchOptions } from "../helpers/user-search";
import { userIndexFor } from "../services/user-search";

const NO_RESULTS: UserSearchEntry[] = [];

/**
 * Bind to a community's shared local member index. `search` is synchronous and
 * local-only; its identity changes whenever the index does, so memos keyed on it
 * re-run on profile/roster updates.
 */
export function useCommunityUserSearch(community: ConcordCommunity | undefined): {
  search: (query: string, opts?: UserSearchOptions) => UserSearchEntry[];
  version: number;
} {
  const index = community ? userIndexFor(community) : undefined;
  const version = use$(index?.version$) ?? 0;
  const search = useCallback(
    (query: string, opts?: UserSearchOptions) => (index ? index.search(query, opts) : NO_RESULTS),
    // `version` invalidates the callback when the index changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, version],
  );
  return { search, version };
}

/** pubkey → display name for every member, for UIs that can't host `<UserName>`. */
export function useCommunityUserNames(community: ConcordCommunity | undefined): Map<string, string> {
  const index = community ? userIndexFor(community) : undefined;
  const version = use$(index?.version$) ?? 0;
  return useMemo(
    () => new Map((index?.list() ?? []).map((e) => [e.pubkey, e.name])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [index, version],
  );
}
