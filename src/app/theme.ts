import { useEffect, useState } from "react";

/**
 * Light/dark theme, following daisyUI's recommended theme-controller pattern:
 * an explicit choice is written as `data-theme` on <html> and persisted to
 * localStorage; the absence of that attribute means "follow the system", which
 * the CSS resolves via `@media (prefers-color-scheme)`. A tiny inline script in
 * index.html re-applies the stored choice before first paint to avoid a flash.
 */
export type ThemePref = "system" | "light" | "dark";

const KEY = "accordion:theme";

/** The persisted preference, defaulting to "system" when nothing is stored. */
export function getStoredTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* localStorage may be unavailable (private mode) — fall back to system. */
  }
  return "system";
}

/** Mirror a preference onto <html data-theme> (removed for "system"). */
export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", pref);
}

/** The actual light/dark theme a preference resolves to right now. */
export function resolveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Persist + apply a preference and notify any mounted `useTheme` hooks. */
export function setTheme(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* ignore persistence failures */
  }
  applyTheme(pref);
  window.dispatchEvent(new Event("accordion:themechange"));
}

/**
 * Read/update the theme preference. Re-renders when the preference changes
 * (via `setTheme`, from anywhere) or — while on "system" — when the OS flips.
 */
export function useTheme(): {
  pref: ThemePref;
  resolved: "light" | "dark";
  setTheme: (p: ThemePref) => void;
} {
  const [pref, setPref] = useState<ThemePref>(getStoredTheme);

  useEffect(() => {
    const onChange = () => setPref(getStoredTheme());
    window.addEventListener("accordion:themechange", onChange);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", onChange);
    return () => {
      window.removeEventListener("accordion:themechange", onChange);
      mq.removeEventListener("change", onChange);
    };
  }, []);

  return { pref, resolved: resolveTheme(pref), setTheme };
}
