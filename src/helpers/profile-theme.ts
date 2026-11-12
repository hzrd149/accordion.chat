import type { NostrEvent } from "nostr-tools";
import { buildDaisyTheme, isDaisyThemeHex, type DaisyThemeInput, type DaisyThemeVariables } from "./daisy-theme";

export const PROFILE_THEME_KIND = 36767;
export const ACTIVE_PROFILE_THEME_KIND = 16767;

export type ProfileThemeFont = {
  family: string;
  url: string;
  role: "body" | "title";
};

export type ProfileThemeBackground = {
  url: string;
  mode: "cover" | "tile";
  mime: string;
  dim?: string;
  blurhash?: string;
};

export type ProfileTheme = {
  id: string;
  author: string;
  kind: typeof PROFILE_THEME_KIND | typeof ACTIVE_PROFILE_THEME_KIND;
  title: string;
  colors: DaisyThemeInput;
  variables: DaisyThemeVariables;
  fonts: ProfileThemeFont[];
  background?: ProfileThemeBackground;
};

function firstTag(tags: string[][], name: string): string | undefined {
  return tags.find((tag) => tag[0] === name)?.[1];
}

function parseColors(tags: string[][]): DaisyThemeInput | null {
  const colors = new Map<string, string>();
  for (const tag of tags) {
    if (tag[0] !== "c") continue;
    const value = tag[1];
    const role = tag[2];
    if (!value || !role || !isDaisyThemeHex(value)) return null;
    if (role !== "background" && role !== "text" && role !== "primary") continue;
    if (colors.has(role)) return null;
    colors.set(role, value);
  }
  const background = colors.get("background");
  const text = colors.get("text");
  const primary = colors.get("primary");
  return background && text && primary ? { background, text, primary } : null;
}

function parseFonts(tags: string[][]): ProfileThemeFont[] {
  const fonts: ProfileThemeFont[] = [];
  const seen = new Set<string>();
  for (const tag of tags) {
    if (tag[0] !== "f") continue;
    const family = tag[1]?.trim();
    const url = tag[2]?.trim();
    const role = (tag[3] ?? "body") as ProfileThemeFont["role"];
    if (!family || !url || (role !== "body" && role !== "title") || seen.has(role)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") continue;
    } catch {
      continue;
    }
    seen.add(role);
    fonts.push({ family, url, role });
  }
  return fonts.sort((a, b) => (a.role === b.role ? 0 : a.role === "body" ? -1 : 1));
}

function parseBackground(tags: string[][]): ProfileThemeBackground | undefined {
  const bg = tags.find((tag) => tag[0] === "bg");
  if (!bg) return undefined;
  const values = new Map<string, string>();
  for (const part of bg.slice(1)) {
    const idx = part.indexOf(" ");
    if (idx < 1) continue;
    values.set(part.slice(0, idx), part.slice(idx + 1));
  }
  const url = values.get("url");
  const mode = values.get("mode");
  const mime = values.get("m");
  if (!url || (mode !== "cover" && mode !== "tile") || !mime) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  } catch {
    return undefined;
  }
  return {
    url,
    mode,
    mime,
    dim: values.get("dim"),
    blurhash: values.get("blurhash"),
  };
}

export function profileThemeAddress(event: NostrEvent): string | null {
  if (event.kind === ACTIVE_PROFILE_THEME_KIND) return `${ACTIVE_PROFILE_THEME_KIND}:${event.pubkey}`;
  if (event.kind !== PROFILE_THEME_KIND) return null;
  const identifier = firstTag(event.tags, "d");
  return identifier ? `${PROFILE_THEME_KIND}:${event.pubkey}:${identifier}` : null;
}

export function parseProfileThemeEvent(event: NostrEvent): ProfileTheme | null {
  if (event.kind !== PROFILE_THEME_KIND && event.kind !== ACTIVE_PROFILE_THEME_KIND) return null;
  const id = profileThemeAddress(event);
  if (!id) return null;
  const colors = parseColors(event.tags);
  if (!colors) return null;
  const identifier = firstTag(event.tags, "d");
  const title = firstTag(event.tags, "title") || identifier || "Active profile theme";
  return {
    id,
    author: event.pubkey,
    kind: event.kind,
    title,
    colors,
    variables: buildDaisyTheme(colors),
    fonts: parseFonts(event.tags),
    background: parseBackground(event.tags),
  };
}
