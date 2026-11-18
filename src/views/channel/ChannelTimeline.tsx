import { Fragment, memo, useMemo } from "react";
import { Hand } from "lucide-react";
import { groupMessages } from "../../helpers/util";
import { useDevMode } from "../../hooks/use-dev-mode";
import type { Emoji } from "../../helpers/emoji";
import type { ChatMessage } from "../../chat/fold";
import type { ConcordCommunity } from "@applesauce/concord";
import { ChannelMessage } from "./ChannelMessage";
import type { ReplyTarget } from "./types";

// The "new messages" line: where you stopped reading last visit. Frozen for the
// duration of the visit by useNewMessagesDivider, so it stays put while you read.
function NewMessagesDivider() {
  return (
    <div className="flex items-center gap-2 px-4 py-1 select-none" data-new-divider>
      <div className="flex-1 h-px bg-error" />
      <span className="text-error text-[10px] font-bold uppercase tracking-wide">New</span>
    </div>
  );
}

export const ChannelTimeline = memo(function ChannelTimeline({
  ref,
  messages,
  channelName,
  ownerPubkey,
  myPubkey,
  canWrite,
  community,
  channelId,
  dividerId,
  favorites,
  quickReactions,
  onReply,
  onJumpToMessage,
  onThread,
}: {
  ref: React.Ref<HTMLDivElement>;
  messages: ChatMessage[];
  channelName: string | undefined;
  ownerPubkey: string;
  myPubkey: string;
  canWrite: boolean;
  community: ConcordCommunity | undefined;
  channelId: string;
  dividerId: string | undefined;
  favorites: Emoji[];
  quickReactions: (string | Emoji)[];
  onReply: (r: ReplyTarget) => void;
  onJumpToMessage: (id: string) => void;
  onThread: (m: ChatMessage) => void;
}) {
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // Collapse consecutive messages from the same author (within 2 min) into one
  // avatar group — Discord/Slack style. Replies always start a fresh header.
  const groups = useMemo(() => groupMessages(messages), [messages]);
  const devMode = useDevMode();

  return (
    <div className="flex-1 flex min-h-0">
      {/* col-reverse puts the scroll origin at the newest message: the view starts
        * pinned to the bottom and stays there as messages arrive, with no scroll
        * effect and no jump. Short history packs against the bottom on its own, so
        * no spacer either. The inner wrapper is one flex item, so groups still read
        * oldest-to-newest inside it. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-4 flex flex-col-reverse" ref={ref}>
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-base-content/60 gap-2 text-center p-10">
            <div className="flex items-center justify-center"><Hand size={48} /></div>
            <div>This is the beginning of #{channelName}. Say hello!</div>
          </div>
        ) : (
          <div>
            {/* All rows share one keyed parent, even when history/authority
              * updates change their visual author grouping. */}
            {groups.flatMap((group) => group.map((m, i) => (
              <Fragment key={m.id}>
                {m.id === dividerId && <NewMessagesDivider />}
                <ChannelMessage
                  m={m}
                  showHeader={i === 0 || Boolean(m.replyTo)}
                  groupStart={i === 0 && m !== messages[0]}
                  replyPreview={m.replyTo ? byId.get(m.replyTo.id)?.content ?? "message" : undefined}
                  ownerPubkey={ownerPubkey}
                  myPubkey={myPubkey}
                  canWrite={canWrite}
                  community={community}
                  channelId={channelId}
                  favorites={favorites}
                  quickReactions={quickReactions}
                  onReply={onReply}
                  onJumpToMessage={onJumpToMessage}
                  onThread={onThread}
                  devMode={devMode}
                />
              </Fragment>
            )))}
          </div>
        )}
      </div>
    </div>
  );
});
