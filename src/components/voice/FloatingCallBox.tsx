// The floating call box: the compact call surface shown when you've navigated
// away from the voice channel (not docked in a channel view, not full screen).
// It can be dragged anywhere on screen and resized from its bottom-right corner;
// its rect is persisted so it reappears where you left it.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

const STORAGE_KEY = "accordion:call-box";
const MIN_W = 260;
const MIN_H = 170;
const MARGIN = 8;

type Rect = { x: number; y: number; w: number; h: number };

function defaultRect(): Rect {
  const w = Math.min(380, window.innerWidth - 2 * MARGIN);
  const h = 320;
  // Top-right, out of the way of the top-left mobile menu button.
  return { x: Math.max(MARGIN, window.innerWidth - w - 16), y: 64, w, h };
}

function clampRect(r: Rect): Rect {
  const w = Math.min(Math.max(r.w, MIN_W), window.innerWidth - 2 * MARGIN);
  const h = Math.min(Math.max(r.h, MIN_H), window.innerHeight - 2 * MARGIN);
  const x = Math.min(Math.max(r.x, 0), Math.max(0, window.innerWidth - w));
  const y = Math.min(Math.max(r.y, 0), Math.max(0, window.innerHeight - h));
  return { x, y, w, h };
}

function loadRect(): Rect {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const r = JSON.parse(raw) as Partial<Rect>;
      if (["x", "y", "w", "h"].every((k) => typeof r[k as keyof Rect] === "number")) {
        return clampRect(r as Rect);
      }
    }
  } catch {
    /* fall through to default */
  }
  return defaultRect();
}

// Don't start a drag when the pointer lands on an interactive control (buttons,
// sliders, links, the resize handle) — those keep their own behaviour.
function isInteractive(target: EventTarget | null): boolean {
  return Boolean(
    (target as HTMLElement | null)?.closest(
      "button, input, a, select, textarea, label, [role='slider'], [data-no-drag]",
    ),
  );
}

type Gesture = { mode: "drag" | "resize"; startX: number; startY: number; orig: Rect };

/** A draggable, resizable fixed-position container for the compact call surface. */
export function FloatingCallBox({ children }: { children: ReactNode }) {
  const [rect, setRect] = useState<Rect>(loadRect);
  const gesture = useRef<Gesture | null>(null);

  // Move/resize are driven off window pointer events so the gesture keeps
  // tracking even when the pointer leaves the box. The gesture's starting rect
  // is captured up-front, so we apply deltas against a stable origin.
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g) return;
      const dx = e.clientX - g.startX;
      const dy = e.clientY - g.startY;
      setRect(
        clampRect(
          g.mode === "drag"
            ? { ...g.orig, x: g.orig.x + dx, y: g.orig.y + dy }
            : { ...g.orig, w: g.orig.w + dx, h: g.orig.h + dy },
        ),
      );
    };
    const onUp = () => {
      if (!gesture.current) return;
      gesture.current = null;
      setRect((r) => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(r));
        } catch {
          /* ignore quota/availability errors */
        }
        return r;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  // Keep the box on screen when the viewport shrinks.
  useEffect(() => {
    const onResize = () => setRect((r) => clampRect(r));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = (e: React.PointerEvent) => {
    if (isInteractive(e.target)) return;
    gesture.current = { mode: "drag", startX: e.clientX, startY: e.clientY, orig: rect };
  };
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    gesture.current = { mode: "resize", startX: e.clientX, startY: e.clientY, orig: rect };
  };

  return (
    <div
      className="fixed z-[60] flex select-none flex-col overflow-hidden rounded-lg border border-base-300 bg-base-200 shadow-2xl"
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
      onPointerDown={startDrag}
    >
      {children}
      <div
        data-no-drag
        onPointerDown={startResize}
        title="Resize"
        className="absolute bottom-0 right-0 flex h-4 w-4 cursor-nwse-resize items-end justify-end p-0.5"
      >
        <span className="h-0 w-0 border-b-[9px] border-l-[9px] border-b-base-content/40 border-l-transparent" />
      </div>
    </div>
  );
}
