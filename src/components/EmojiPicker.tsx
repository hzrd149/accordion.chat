import { useEffect, useRef } from "react";
import { DEFAULT_REACTIONS, type Emoji } from "../lib/emoji";

// A small emoji picker popover: a row of default unicode reactions plus the
// user's NIP-30 favorite custom emojis (rendered as images). Picking calls back
// with either a unicode string or a custom `Emoji`. The parent positions it by
// wrapping the trigger in a `position: relative` container.

export function EmojiPicker({
  favorites,
  onPick,
  onClose,
  align = "left",
  direction = "down",
}: {
  favorites: Emoji[];
  onPick: (reaction: string | Emoji) => void;
  onClose: () => void;
  align?: "left" | "right";
  direction?: "up" | "down";
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Defer so the click that opened the picker doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener("mousedown", onDown), 0);
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function pick(reaction: string | Emoji) {
    onPick(reaction);
    onClose();
  }

  return (
    <div
      ref={ref}
      className={`absolute ${direction === "up" ? "bottom-full mb-1.5" : "top-full mt-1.5"} z-50 w-58 max-h-65 overflow-y-auto p-2 bg-base-200 border border-base-300 rounded-box shadow-lg ${
        align === "right" ? "right-0" : "left-0"
      }`}
      role="menu"
    >
      <div className="grid grid-cols-6 gap-0.5">
        {DEFAULT_REACTIONS.map((e) => (
          <button
            key={e}
            className="btn btn-ghost btn-sm p-0 h-auto min-h-0 aspect-square text-xl leading-none"
            onClick={() => pick(e)}
            title={e}
          >
            {e}
          </button>
        ))}
      </div>
      {favorites.length > 0 && (
        <>
          <div className="mt-2 mb-1 mx-0.5 text-[11px] uppercase tracking-wide text-base-content/60">Favorites</div>
          <div className="grid grid-cols-6 gap-0.5">
            {favorites.map((e) => (
              <button
                key={e.shortcode}
                className="btn btn-ghost btn-sm p-0 h-auto min-h-0 aspect-square text-xl leading-none"
                onClick={() => pick(e)}
                title={`:${e.shortcode}:`}
              >
                <img className="h-[1.35em] w-auto align-middle object-contain" src={e.url} alt={`:${e.shortcode}:`} loading="lazy" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
