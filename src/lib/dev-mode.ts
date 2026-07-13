import { useEffect, useState } from "react";

/**
 * "Developer mode" — an opt-in local preference that surfaces the /dev tools
 * (rail button + routes). Mirrors the theme.ts pattern: a boolean persisted to
 * localStorage, a setter that notifies mounted hooks via a window event, and a
 * `useDevMode` hook so any component re-renders when it flips app-wide. Purely a
 * client-side UI preference — nothing here is published to Nostr.
 */
const KEY = "accordion:devMode";
const EVENT = "accordion:devmodechange";

/** The persisted flag, defaulting to false when nothing is stored. */
export function getDevMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    /* localStorage may be unavailable (private mode) — default off. */
    return false;
  }
}

/** Persist the flag and notify any mounted `useDevMode` hooks. */
export function setDevMode(enabled: boolean) {
  try {
    if (enabled) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore persistence failures */
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Read/subscribe to the developer-mode flag; re-renders when it changes. */
export function useDevMode(): boolean {
  const [enabled, setEnabled] = useState<boolean>(getDevMode);
  useEffect(() => {
    const onChange = () => setEnabled(getDevMode());
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, []);
  return enabled;
}
