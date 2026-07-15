import { useEffect, useState } from "react";
import { buildDaisyTheme, isDaisyThemeHex, type DaisyThemeInput, type DaisyThemeVariables } from "./daisy-theme";

export type ThemeMode = "system" | "light" | "dark";
export type ThemeSlot = "light" | "dark";

export type DaisyThemeChoice = { type: "daisy"; name: string };
export type NostrThemeChoice = {
  type: "nostr";
  id: string;
  title: string;
  author: string;
  colors: DaisyThemeInput;
  variables: DaisyThemeVariables;
};
export type ThemeChoice = DaisyThemeChoice | NostrThemeChoice;

export type AppearanceConfig = {
  mode: ThemeMode;
  light: ThemeChoice;
  dark: ThemeChoice;
};

export type ThemePref = ThemeMode;

export const APPEARANCE_KEY = "accordion:appearance";
const OLD_THEME_KEY = "accordion:theme";
const RUNTIME_THEME = "accordion-runtime";
const CHANGE_EVENT = "accordion:themechange";

export const LIGHT_DAISY_THEMES = [
  "light",
  "cupcake",
  "bumblebee",
  "emerald",
  "corporate",
  "retro",
  "cyberpunk",
  "valentine",
  "garden",
  "lofi",
  "pastel",
  "fantasy",
  "wireframe",
  "cmyk",
  "autumn",
  "acid",
  "lemonade",
  "winter",
  "nord",
  "caramellatte",
  "silk",
] as const;

export const DARK_DAISY_THEMES = [
  "dark",
  "synthwave",
  "halloween",
  "forest",
  "aqua",
  "black",
  "luxury",
  "dracula",
  "business",
  "night",
  "coffee",
  "dim",
  "sunset",
  "abyss",
] as const;

const DEFAULT_CONFIG: AppearanceConfig = {
  mode: "system",
  light: { type: "daisy", name: "light" },
  dark: { type: "daisy", name: "dark" },
};

const RUNTIME_VARIABLES = [
  "color-scheme",
  "--color-base-100",
  "--color-base-200",
  "--color-base-300",
  "--color-base-content",
  "--color-primary",
  "--color-primary-content",
  "--color-secondary",
  "--color-secondary-content",
  "--color-accent",
  "--color-accent-content",
  "--color-neutral",
  "--color-neutral-content",
  "--color-info",
  "--color-info-content",
  "--color-success",
  "--color-success-content",
  "--color-warning",
  "--color-warning-content",
  "--color-error",
  "--color-error-content",
  "--radius-selector",
  "--radius-field",
  "--radius-box",
  "--size-selector",
  "--size-field",
  "--border",
  "--depth",
  "--noise",
];

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

function isDaisyChoice(value: unknown): value is DaisyThemeChoice {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "daisy" && typeof (value as { name?: unknown }).name === "string");
}

function isThemeColors(value: unknown): value is DaisyThemeInput {
  const colors = value as Partial<DaisyThemeInput> | null;
  return Boolean(
    colors &&
      typeof colors.background === "string" &&
      typeof colors.text === "string" &&
      typeof colors.primary === "string" &&
      isDaisyThemeHex(colors.background) &&
      isDaisyThemeHex(colors.text) &&
      isDaisyThemeHex(colors.primary),
  );
}

function isNostrChoice(value: unknown): value is NostrThemeChoice {
  const choice = value as Partial<NostrThemeChoice> | null;
  return Boolean(
    choice &&
      choice.type === "nostr" &&
      typeof choice.id === "string" &&
      typeof choice.title === "string" &&
      typeof choice.author === "string" &&
      isThemeColors(choice.colors) &&
      choice.variables,
  );
}

function normalizeChoice(value: unknown, fallback: ThemeChoice): ThemeChoice {
  if (isDaisyChoice(value)) return value;
  const choice = value as Partial<NostrThemeChoice> | null;
  if (
    choice &&
    choice.type === "nostr" &&
    typeof choice.id === "string" &&
    typeof choice.title === "string" &&
    typeof choice.author === "string" &&
    isThemeColors(choice.colors)
  ) {
    return {
      type: "nostr",
      id: choice.id,
      title: choice.title,
      author: choice.author,
      colors: choice.colors,
      // Persist runtime variables with the selected theme so first paint never
      // depends on refetching the Nostr event or hydrating the EventStore.
      variables: buildDaisyTheme(choice.colors),
    };
  }
  return fallback;
}

function sanitizeChoice(value: unknown, fallback: ThemeChoice): ThemeChoice {
  return isDaisyChoice(value) || isNostrChoice(value) ? normalizeChoice(value, fallback) : fallback;
}

function normalizeConfig(config: AppearanceConfig): AppearanceConfig {
  return {
    mode: config.mode,
    light: normalizeChoice(config.light, DEFAULT_CONFIG.light),
    dark: normalizeChoice(config.dark, DEFAULT_CONFIG.dark),
  };
}

function sanitizeConfig(value: unknown): AppearanceConfig | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AppearanceConfig>;
  return normalizeConfig({
    mode: isThemeMode(raw.mode) ? raw.mode : DEFAULT_CONFIG.mode,
    light: sanitizeChoice(raw.light, DEFAULT_CONFIG.light),
    dark: sanitizeChoice(raw.dark, DEFAULT_CONFIG.dark),
  });
}

function readOldConfig(): AppearanceConfig | null {
  try {
    const old = localStorage.getItem(OLD_THEME_KEY);
    if (old === "light" || old === "dark") return { ...DEFAULT_CONFIG, mode: old };
  } catch {
    /* ignore old-key migration failures */
  }
  return null;
}

export function getStoredAppearance(): AppearanceConfig {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (raw) {
      const parsed = sanitizeConfig(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* fall through to old key/default */
  }
  return readOldConfig() ?? DEFAULT_CONFIG;
}

export function getStoredTheme(): ThemeMode {
  return getStoredAppearance().mode;
}

export function resolveThemeSlot(mode: ThemeMode): ThemeSlot {
  if (mode !== "system") return mode;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(pref: ThemeMode): ThemeSlot {
  return resolveThemeSlot(pref);
}

export function activeThemeChoice(config: AppearanceConfig): ThemeChoice {
  return config[resolveThemeSlot(config.mode)];
}

function clearRuntimeVariables(root: HTMLElement) {
  for (const name of RUNTIME_VARIABLES) root.style.removeProperty(name);
}

function applyChoice(choice: ThemeChoice) {
  const root = document.documentElement;
  clearRuntimeVariables(root);
  if (choice.type === "daisy") {
    root.setAttribute("data-theme", choice.name);
    return;
  }
  root.setAttribute("data-theme", RUNTIME_THEME);
  for (const [name, value] of Object.entries(choice.variables)) root.style.setProperty(name, value);
}

export function applyAppearance(config: AppearanceConfig) {
  applyChoice(activeThemeChoice(config));
}

export function applyTheme(pref: ThemeMode) {
  applyAppearance({ ...getStoredAppearance(), mode: pref });
}

export function setAppearance(config: AppearanceConfig) {
  const normalized = normalizeConfig(config);
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(normalized));
    localStorage.removeItem(OLD_THEME_KEY);
  } catch {
    /* ignore persistence failures */
  }
  applyAppearance(normalized);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function setTheme(pref: ThemeMode) {
  setAppearance({ ...getStoredAppearance(), mode: pref });
}

export function setThemeSlot(slot: ThemeSlot, choice: ThemeChoice) {
  setAppearance({ ...getStoredAppearance(), [slot]: choice });
}

export function toggleResolvedTheme() {
  const config = getStoredAppearance();
  setAppearance({ ...config, mode: resolveThemeSlot(config.mode) === "dark" ? "light" : "dark" });
}

export function useTheme(): {
  config: AppearanceConfig;
  pref: ThemeMode;
  resolved: ThemeSlot;
  activeChoice: ThemeChoice;
  setAppearance: (config: AppearanceConfig) => void;
  setMode: (mode: ThemeMode) => void;
  setTheme: (mode: ThemeMode) => void;
  setSlotTheme: (slot: ThemeSlot, choice: ThemeChoice) => void;
  toggleResolvedTheme: () => void;
} {
  const [config, setConfig] = useState<AppearanceConfig>(getStoredAppearance);

  useEffect(() => {
    const onChange = () => {
      const next = getStoredAppearance();
      applyAppearance(next);
      setConfig(next);
    };
    window.addEventListener(CHANGE_EVENT, onChange);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  const resolved = resolveThemeSlot(config.mode);
  return {
    config,
    pref: config.mode,
    resolved,
    activeChoice: config[resolved],
    setAppearance,
    setMode: setTheme,
    setTheme,
    setSlotTheme: setThemeSlot,
    toggleResolvedTheme,
  };
}
