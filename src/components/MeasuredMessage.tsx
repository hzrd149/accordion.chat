import { useLayoutEffect, useRef } from "react";
import type { MessageHeightCache, MessageLayout } from "../helpers/message-heights";

/** Preserve a remounted row's space until its asynchronous content has settled.
 * Observe natural content separately: measuring a min-height-constrained box
 * would otherwise make an old height impossible to shrink after edits/errors. */
export function MeasuredMessage({ layout, width, cache, children }: {
  layout: MessageLayout;
  width: number;
  cache: MessageHeightCache;
  children: React.ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const reserved = cache.get(layout, width);

  useLayoutEffect(() => {
    const outer = frame.current!;
    const inner = content.current!;
    let height = cache.get(layout, width) ?? 0;
    const measure = () => {
      const natural = inner.getBoundingClientRect().height;
      if (natural <= 0 || outer.getBoundingClientRect().width <= 0) return;
      const pending = inner.querySelector("[data-message-pending]") !== null;
      height = pending ? Math.max(height, natural) : natural;
      outer.style.minHeight = pending ? `${height}px` : "";
      cache.set(layout, width, height);
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(inner);
    // Loading -> ready/error may change no dimensions (the reservation worked),
    // but still needs to release the temporary minimum height.
    const mutations = new MutationObserver(measure);
    mutations.observe(inner, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-message-pending"] });
    return () => { resize.disconnect(); mutations.disconnect(); };
  }, [cache, layout, width]);

  return (
    <div ref={frame} style={{ minHeight: reserved }}>
      <div ref={content} className="flow-root">{children}</div>
    </div>
  );
}
