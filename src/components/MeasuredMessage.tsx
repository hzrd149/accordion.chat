import { useLayoutEffect, useRef, useState } from "react";
import type { MessageHeightCache, MessageLayout } from "../helpers/message-heights";
import { sameMessageLayout } from "../helpers/message-heights";

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
  const { message, showHeader, groupStart, divider } = layout;
  // Capture the reservation, rather than feeding the mutable measurement cache
  // straight back into React's styles on every virtualizer render. React alone
  // owns minHeight; observers must never imperatively write that same property.
  const [reservation, setReservation] = useState(() => ({
    layout, width, pending: true, height: cache.get(layout, width) ?? 0,
  }));
  if (reservation.width !== width || !sameMessageLayout(reservation.layout, layout)) {
    setReservation({ layout, width, pending: true, height: cache.get(layout, width) ?? 0 });
  }

  useLayoutEffect(() => {
    const outer = frame.current!;
    const inner = content.current!;
    const currentLayout = { message, showHeader, groupStart, divider };
    let height = cache.get(currentLayout, width) ?? 0;
    let lastPending = true;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const natural = inner.getBoundingClientRect().height;
      if (natural <= 0 || outer.getBoundingClientRect().width <= 0) return;
      const pending = inner.querySelector("[data-message-pending]") !== null;
      height = pending ? Math.max(height, natural) : natural;
      cache.set(currentLayout, width, height);
      // Only readiness is React state. In particular, never feed a measurement
      // back into this mount's minimum height: larger content naturally grows
      // past the captured reservation, without a resize -> state -> resize loop.
      if (lastPending !== pending) {
        lastPending = pending;
        setReservation((previous) => previous.pending === pending ? previous : { ...previous, pending });
      }
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(inner);
    // Loading -> ready/error may change no dimensions (the reservation worked),
    // but still needs to release the temporary minimum height.
    const mutations = new MutationObserver(measure);
    mutations.observe(inner, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-message-pending"] });
    return () => { disposed = true; resize.disconnect(); mutations.disconnect(); };
  }, [cache, message, showHeader, groupStart, divider, width]);

  return (
    <div ref={frame} style={{ minHeight: reservation.pending && reservation.height > 0 ? reservation.height : undefined }}>
      <div ref={content} className="flow-root">{children}</div>
    </div>
  );
}
