import { useEffect, useRef } from "react";
import { DEFAULT_REACTIONS, type Emoji } from "./emoji";

// A small emoji picker popover: a row of default unicode reactions plus the
// user's NIP-30 favorite custom emojis (rendered as images). Picking calls back
// with either a unicode string or a custom `Emoji`. The parent positions it by
// wrapping the trigger in a `position: relative` container.

export function EmojiPicker({
  favorites,
  onPick,
  onClose,
  align = "left",
}: {
  favorites: Emoji[];
  onPick: (reaction: string | Emoji) => void;
  onClose: () => void;
  align?: "left" | "right";
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
    <div ref={ref} className={`emoji-picker ${align}`} role="menu">
      <div className="emoji-picker-grid">
        {DEFAULT_REACTIONS.map((e) => (
          <button key={e} className="emoji-picker-btn" onClick={() => pick(e)} title={e}>
            {e}
          </button>
        ))}
      </div>
      {favorites.length > 0 && (
        <>
          <div className="emoji-picker-label">Favorites</div>
          <div className="emoji-picker-grid">
            {favorites.map((e) => (
              <button key={e.shortcode} className="emoji-picker-btn" onClick={() => pick(e)} title={`:${e.shortcode}:`}>
                <img className="inline-emoji" src={e.url} alt={`:${e.shortcode}:`} loading="lazy" />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
