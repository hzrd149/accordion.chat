/**
 * "Developer mode" — an opt-in local preference that surfaces the /dev tools
 * (rail button + routes). Mirrors the theme.ts pattern: a boolean persisted to
 * localStorage, a setter that notifies mounted hooks via a window event, and a
 * `useDevMode` hook so any component re-renders when it flips app-wide. Purely a
 * client-side preference — nothing here is published to Nostr. Also controls
 * nostr-idb console logging and timings across the public cache and rumor stores.
 */
import { configureDiagnostics } from "nostr-idb";

const KEY = "accordion:devMode";
export const DEV_MODE_CHANGE_EVENT = "accordion:devmodechange";

/** The persisted flag, defaulting to false when nothing is stored. */
export function getDevMode(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    /* localStorage may be unavailable (private mode) — default off. */
    return false;
  }
}

// Apply the saved preference before the first database operations at startup.
configureDiagnostics({ debug: getDevMode(), timing: getDevMode() });

/** Persist the flag and notify any mounted `useDevMode` hooks. */
export function setDevMode(enabled: boolean) {
  configureDiagnostics({ debug: enabled, timing: enabled });
  try {
    if (enabled) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore persistence failures */
  }
  window.dispatchEvent(new Event(DEV_MODE_CHANGE_EVENT));
}
