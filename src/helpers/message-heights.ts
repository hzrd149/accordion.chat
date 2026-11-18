import type { ChatMessage } from "../chat/fold";

export interface MessageLayout {
  message: ChatMessage;
  showHeader: boolean;
  groupStart: boolean;
  divider: boolean;
}

export function sameMessageLayout(a: MessageLayout, b: MessageLayout): boolean {
  return a.message === b.message && a.showHeader === b.showHeader &&
    a.groupStart === b.groupStart && a.divider === b.divider;
}

/** Owned by one mounted timeline, never by a global service or browser storage. */
export function createMessageHeightCache() {
  const heights = new Map<string, { layout: MessageLayout; width: number; height: number }>();
  return {
    get(layout: MessageLayout, width: number) {
      const saved = heights.get(layout.message.id);
      return saved && saved.width === width && sameMessageLayout(saved.layout, layout) ? saved.height : undefined;
    },
    set(layout: MessageLayout, width: number, height: number) {
      // Hidden/disconnected elements must not poison the measurements.
      if (width > 0 && height > 0 && Number.isFinite(height))
        heights.set(layout.message.id, { layout, width, height });
    },
    retain(ids: Set<string>) {
      for (const id of heights.keys()) if (!ids.has(id)) heights.delete(id);
    },
  };
}

export type MessageHeightCache = ReturnType<typeof createMessageHeightCache>;
