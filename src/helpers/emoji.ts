import type { Emoji } from "applesauce-common/helpers";

export type { Emoji };

/** Default unicode reactions offered when the user has no custom favorites. */
export const DEFAULT_REACTIONS = ["👍", "❤️", "😂", "🔥", "🎉", "😮", "😢", "🙏"];

/** Dedupe emojis by shortcode, keeping the first-seen URL. */
export function dedupeEmojis(emojis: Emoji[]): Emoji[] {
  const seen = new Set<string>();
  return emojis.filter((e) => (seen.has(e.shortcode) ? false : (seen.add(e.shortcode), true)));
}
