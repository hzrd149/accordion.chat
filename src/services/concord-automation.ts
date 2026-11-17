import type { ConcordClientOptions } from "@applesauce/concord";
import { BehaviorSubject } from "rxjs";

type AutomationKey = "autoUnlock" | "autoSaveCommunityList" | "watchDirectInvites" | "pinUpkeep";
export type ConcordAutomation = Required<Pick<ConcordClientOptions, AutomationKey>>;

const KEY = "accordion:concordAutomation";
const defaults: ConcordAutomation = {
  autoUnlock: true,
  autoSaveCommunityList: true,
  watchDirectInvites: true,
  pinUpkeep: true,
};

function loadAutomation(): ConcordAutomation {
  const settings = { ...defaults };
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(defaults) as AutomationKey[]) {
        const value = (stored as Record<string, unknown>)[key];
        if (typeof value === "boolean") settings[key] = value;
      }
    }
  } catch { /* Invalid or unavailable storage uses the existing app defaults. */ }
  return settings;
}

// Concord's automation options are constructor-only. Keep every client created
// during this page lifetime on the same settings; edits take effect after reload.
export const activeConcordAutomation = loadAutomation();
export const concordAutomation$ = new BehaviorSubject<ConcordAutomation>({ ...activeConcordAutomation });

export function setConcordAutomation(key: AutomationKey, enabled: boolean) {
  const settings = { ...concordAutomation$.value, [key]: enabled };
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    throw new Error("Could not save Concord automation settings in this browser.");
  }
  concordAutomation$.next(settings);
}
