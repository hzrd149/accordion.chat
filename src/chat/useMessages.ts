// Shared ban- and authority-aware channel projections for chat and NIP-22 threads.

import { useMemo } from "react";
import { map } from "rxjs";
import { use$ } from "applesauce-react/hooks";
import type { ConcordCommunity } from "@applesauce/concord";
import type { ChatMessage, ThreadComment } from "./fold";
import { channelProjection } from "./projection";

const NO_MESSAGES: ChatMessage[] = [];
const NO_COMMENTS: ThreadComment[] = [];

/** The folded, live message list for a channel. */
export function useMessages(community: ConcordCommunity | undefined, channelId: string): ChatMessage[] {
  const messages$ = useMemo(
    () =>
      community
        ? channelProjection(community, channelId).pipe(map((view) => view.messages))
        : undefined,
    [community, channelId],
  );
  return use$(messages$) ?? NO_MESSAGES;
}

/** The folded, live NIP-22 comment thread rooted at `rootId` for a channel. */
export function useThread(
  community: ConcordCommunity | undefined,
  channelId: string,
  rootId: string,
): ThreadComment[] {
  const thread$ = useMemo(
    () =>
      community
        ? channelProjection(community, channelId).pipe(map((view) => view.threads.get(rootId) ?? NO_COMMENTS))
        : undefined,
    [community, channelId, rootId],
  );
  return use$(thread$) ?? NO_COMMENTS;
}
