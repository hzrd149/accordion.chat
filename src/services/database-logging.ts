import { configureDiagnostics } from "nostr-idb";
import { BehaviorSubject } from "rxjs";

const KEY = "accordion:databaseLogging";

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch { return false; }
}

export const databaseLogging$ = new BehaviorSubject<boolean>(loadEnabled());

// Restore diagnostics before opening the public cache or rumor stores.
configureDiagnostics({ debug: databaseLogging$.value, timing: databaseLogging$.value });

export function setDatabaseLogging(enabled: boolean) {
  configureDiagnostics({ debug: enabled, timing: enabled });
  try {
    if (enabled) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch { /* Keep the in-memory preference when storage is unavailable. */ }
  databaseLogging$.next(enabled);
}
