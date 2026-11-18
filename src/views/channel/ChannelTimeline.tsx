import { memo, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Hand } from "lucide-react";
import { groupMessages } from "../../helpers/util";
import { useDevMode } from "../../hooks/use-dev-mode";
import type { Emoji } from "../../helpers/emoji";
import type { ChatMessage } from "../../chat/fold";
import type { ConcordCommunity } from "@applesauce/concord";
import { ChannelMessage } from "./ChannelMessage";
import type { ReplyTarget } from "./types";
import { createMessageHeightCache } from "../../helpers/message-heights";
import { MeasuredMessage } from "../../components/MeasuredMessage";

export interface ChannelTimelineHandle {
  scrollToMessage(id: string, align?: "start" | "center"): boolean;
}

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
  onAtBottomChange,
}: {
  ref: React.Ref<ChannelTimelineHandle>;
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
  onAtBottomChange: (atBottom: boolean) => void;
}) {
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // Collapse consecutive messages from the same author (within 2 min) into one
  // avatar group — Discord/Slack style. Replies always start a fresh header.
  const rows = useMemo(
    () => groupMessages(messages).flatMap((group) => group.map((message, i) => ({
      message,
      showHeader: i === 0 || Boolean(message.replyTo),
      groupStart: i === 0 && message !== messages[0],
      divider: message.id === dividerId,
    }))),
    [messages, dividerId],
  );
  const devMode = useDevMode();
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<string | null>(null);
  const started = useRef(false);
  const [cache] = useState(createMessageHeightCache);
  const [width, setWidth] = useState(0);
  const getItemKey = useCallback((index: number) => rows[index].message.id, [rows]);
  // React Compiler is not enabled here; this mutable library instance must not
  // be compiler-memoized if it is enabled in future.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: (index) => cache.get(rows[index], width) ??
      (rows[index].message.attachments.length ? 300 : rows[index].showHeader ? 72 : 36),
    overscan: 8,
    anchorTo: "end",
    followOnAppend: true,
    scrollEndThreshold: 80,
    paddingStart: 16,
    paddingEnd: 16,
    onChange: (instance) => onAtBottomChange(instance.isAtEnd()),
  });
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.end <= (instance.scrollOffset ?? 0);

  useLayoutEffect(() => {
    const el = scrollRef.current!;
    const update = () => { if (el.clientWidth > 0) setWidth(el.clientWidth); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Width changes invalidate row reservations, not the whole scroll geometry.
  // ResizeObserver remeasures mounted rows; offscreen sizes remain estimates
  // until revisited. Clearing all measurements here would move the reader.
  useLayoutEffect(() => {
    cache.retain(new Set(messages.map((m) => m.id)));
  }, [cache, messages]);

  const focusTarget = useCallback(() => {
    if (!pendingFocus.current) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(pendingFocus.current)}"]`);
    if (target) {
      target.focus({ preventScroll: true });
      pendingFocus.current = null;
    }
  }, []);
  useImperativeHandle(ref, () => ({
    scrollToMessage(id, align = "center") {
      const index = rows.findIndex((row) => row.message.id === id);
      if (index < 0) return false;
      started.current = true;
      pendingFocus.current = id;
      // Unknown intermediate heights make smooth scrolling an unstable target.
      virtualizer.scrollToIndex(index, { align, behavior: "auto" });
      focusTarget();
      return true;
    },
  }), [rows, virtualizer, focusTarget]);
  useLayoutEffect(focusTarget);

  useLayoutEffect(() => {
    if (!width || !rows.length || started.current) return;
    started.current = true;
    virtualizer.scrollToEnd();
  }, [rows.length, width, virtualizer]);

  const items = virtualizer.getVirtualItems();
  // Keep a short conversation bottom-aligned without reversing scroll offsets.
  const total = virtualizer.getTotalSize();
  const topInset = Math.max(0, (virtualizer.scrollRect?.height ?? 0) - total);

  return (
    <div className="flex-1 flex min-h-0">
      <div className="flex-1 min-w-0 overflow-y-auto overflow-x-hidden [overflow-anchor:none]" ref={scrollRef}
        onWheel={() => virtualizer.cancelScroll()}
        onTouchStart={() => virtualizer.cancelScroll()}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) virtualizer.cancelScroll();
        }}>
        {messages.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-base-content/60 gap-2 text-center p-10">
            <div className="flex items-center justify-center"><Hand size={48} /></div>
            <div>This is the beginning of #{channelName}. Say hello!</div>
          </div>
        ) : (
          <div className="relative w-full" style={{ height: total + topInset }}>
            {items.map((item) => {
              const layout = rows[item.index];
              const m = layout.message;
              return (
                <div key={m.id} data-index={item.index} ref={virtualizer.measureElement}
                  className="absolute left-0 top-0 w-full focus-within:z-10"
                  style={{ top: item.start + topInset }}>
                  <MeasuredMessage layout={layout} width={width} cache={cache}>
                    {layout.divider && <NewMessagesDivider />}
                    <ChannelMessage
                      m={m}
                      showHeader={layout.showHeader}
                      groupStart={layout.groupStart}
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
                  </MeasuredMessage>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
});
