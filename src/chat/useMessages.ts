// React hooks that fold a community channel's RumorStore into the message/thread
// lists the UI renders. `RumorStore.timeline()` re-emits on every add — so the
// optimistic local echo in ConcordCommunity's publish path drives live updates —
// and `map(fold*)` runs the pure fold per emission.

import { useMemo } from "react";
import { map } from "rxjs";
import { use$ } from "applesauce-react/hooks";
import type { ConcordCommunity } from "applesauce-concord";
import { EDIT_KIND } from "applesauce-concord/helpers";
import { kinds } from "nostr-tools";
import { foldMessages, foldThread, type ChatMessage, type ThreadComment } from "./fold";

const MESSAGE_KINDS = [kinds.ChatMessage, kinds.Reaction, kinds.EventDeletion, EDIT_KIND, 1111];
const NO_MESSAGES: ChatMessage[] = [];
const NO_COMMENTS: ThreadComment[] = [];

/** The folded, live message list for a channel. */
export function useMessages(community: ConcordCommunity | undefined, channelId: string): ChatMessage[] {
  const messages$ = useMemo(
    () =>
      community
        ? community.channelStore(channelId).timeline([{ kinds: MESSAGE_KINDS }]).pipe(map(foldMessages))
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
        ? community
            .channelStore(channelId)
            .timeline([{ kinds: [1111] }])
            .pipe(map((rumors) => foldThread(rumors, rootId)))
        : undefined,
    [community, channelId, rootId],
  );
  return use$(thread$) ?? NO_COMMENTS;
}
