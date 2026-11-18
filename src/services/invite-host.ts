/**
 * Which Concord client an invite link should open in. Invite links are
 * `$BASE/invite/<naddr>#<fragment>` and every client accepts the same path, so
 * the host is a presentation choice: the stored link keeps whatever base it was
 * minted with, and we swap the origin when showing or copying it.
 * Persisted locally; nothing here is published.
 */
import { BehaviorSubject } from "rxjs";

export interface InviteHostPreset {
  /** Stable key persisted to localStorage. */
  id: string;
  label: string;
  /** Origin to put in front of `/invite/…`; `undefined` means this app's own origin. */
  base?: string;
}

/** Web clients from https://concordprotocol.org/clients/ that open in a browser. */
export const INVITE_HOST_PRESETS: InviteHostPreset[] = [
  { id: "this", label: "This app" },
  { id: "accordion", label: "Accordion", base: "https://accordion.chat" },
  { id: "armada", label: "Armada", base: "https://armada.buzz" },
  { id: "posterchan", label: "PosterChan", base: "https://poster.place" },
  { id: "grimoire", label: "Grimoire", base: "https://grimoire.rocks" },
  { id: "coinos", label: "Coinos", base: "https://v3.coinos.io" },
];

const KEY = "accordion:inviteHost";

function load(): string {
  try {
    const id = localStorage.getItem(KEY);
    if (id && INVITE_HOST_PRESETS.some((p) => p.id === id)) return id;
  } catch {
    /* localStorage may be unavailable (private mode) */
  }
  return "this";
}

/** The selected preset id. */
export const inviteHost$ = new BehaviorSubject<string>(load());

export function setInviteHost(id: string) {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* ignore persistence failures */
  }
  inviteHost$.next(id);
}

/** The origin a preset resolves to. */
export function inviteHostBase(id: string): string {
  return INVITE_HOST_PRESETS.find((p) => p.id === id)?.base ?? window.location.origin;
}

/** Re-home an invite URL onto another client, keeping its path and secret fragment. */
export function rehostInviteUrl(url: string, base: string): string {
  try {
    const u = new URL(url);
    return new URL(u.pathname + u.search + u.hash, base).toString();
  } catch {
    return url;
  }
}
