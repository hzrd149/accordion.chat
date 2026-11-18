import { BehaviorSubject } from "rxjs";
import { NostrConnectSigner, PasswordSigner, PrivateKeySigner } from "applesauce-signers";
import { COMMUNITY_LIST_KIND, INVITE_LIST_KIND } from "@applesauce/concord/helpers";
import { accounts, accountAwaitingUnlock$, eventStore } from "../nostr";
import { eraseAccountData } from "../helpers/account-erasure";
import { finishAccountErasure, retireAccountResources } from "./account-lifecycle";

const PREFIX = "accordion:logout:";
export interface LogoutState {
  pubkey: string;
  status: "busy" | "error";
  error?: string;
}
export const logouts$ = new BehaviorSubject<LogoutState[]>([]);
const jobs = new Map<string, Promise<boolean>>();

function update(pubkey: string, state?: LogoutState) {
  const rest = logouts$.value.filter((entry) => entry.pubkey !== pubkey);
  logouts$.next(state ? [...rest, state] : rest);
}

/** Local sign-out, never community leave, grant revocation, or list publication. */
export function logoutAccount(pubkey: string): Promise<boolean> {
  const running = jobs.get(pubkey);
  if (running) return running;
  const job = performLogout(pubkey).finally(() => jobs.delete(pubkey));
  jobs.set(pubkey, job);
  return job;
}

async function performLogout(pubkey: string): Promise<boolean> {
  update(pubkey, { pubkey, status: "busy" });
  const errors: unknown[] = [];
  const marker = PREFIX + pubkey;
  let ticket: string | null = null;
  try {
    ticket = localStorage.getItem(marker) ?? crypto.randomUUID();
    // Also tells other open Accordion tabs to stop this account before deletion.
    localStorage.setItem(marker, ticket);
  } catch (error) { errors.push(error); }

  // Retirement is synchronous up to its first await, before any React teardown.
  const retired = retireAccountResources(pubkey);
  const removed = accounts.accounts.filter((account) => account.pubkey === pubkey);
  for (const account of removed) {
    if ("abortQueue" in account && typeof account.abortQueue === "function") {
      account.abortQueue(new Error("Signed out"));
    }
    accounts.removeAccount(account);
  }
  if (accountAwaitingUnlock$.value?.pubkey === pubkey) accountAwaitingUnlock$.next(undefined);
  try {
    // Unlike best-effort normal account persistence, logout must report a
    // storage failure rather than leave a reload-restorable credential behind.
    localStorage.setItem("concord:accounts", JSON.stringify(accounts.toJSON()));
    if (accounts.active) localStorage.setItem("concord:active", accounts.active.id);
    else localStorage.removeItem("concord:active");
  } catch (error) { errors.push(error); }

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out closing account resources")), 8000);
      retired.then(resolve, reject).finally(() => clearTimeout(timer));
    });
  } catch (error) { errors.push(error); }
  // Signed list events may carry in-memory hidden-content caches containing
  // memberships and keys. Their encrypted public-event disk cache can remain.
  try { eventStore.removeByFilters({ authors: [pubkey], kinds: [COMMUNITY_LIST_KIND, INVITE_LIST_KIND] }); }
  catch (error) { errors.push(error); }
  for (const account of removed) {
    try {
      if (account.signer instanceof NostrConnectSigner) await account.signer.close();
      else if (account.signer instanceof PasswordSigner) account.signer.lock();
      else if (account.signer instanceof PrivateKeySigner) account.signer.key.fill(0);
    } catch (error) { errors.push(error); }
  }
  try {
    const erase = async () => {
      // Another tab may have completed the same logout while we drained.
      if (ticket && localStorage.getItem(marker) !== ticket) return;
      await eraseAccountData(pubkey);
      if (!errors.length) localStorage.removeItem(marker);
    };
    // Prevent a delayed peer from erasing newly-created data after the first
    // tab has completed logout and allowed a fresh sign-in.
    if (typeof navigator !== "undefined" && navigator.locks) {
      await navigator.locks.request(`accordion:logout:${pubkey}`, erase);
    } else await erase();
  } catch (error) { errors.push(error); }

  if (errors.length) {
    console.warn("Local sign-out cleanup incomplete", new AggregateError(errors));
    update(pubkey, {
      pubkey, status: "error",
      error: "Local data could not be fully removed. Close other Accordion tabs and retry. Your community memberships have not been changed.",
    });
    return false;
  }
  finishAccountErasure(pubkey);
  update(pubkey);
  return true;
}

/** Resume interrupted erasure before services start; coordinate other open tabs. */
export function initializeLogout() {
  const onStorage = (event: StorageEvent) => {
    if (event.key?.startsWith(PREFIX) && event.newValue) {
      const pubkey = event.key.slice(PREFIX.length);
      if (/^[0-9a-f]{64}$/.test(pubkey)) void logoutAccount(pubkey);
    }
  };
  window.addEventListener("storage", onStorage);
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      const pubkey = key?.startsWith(PREFIX) ? key.slice(PREFIX.length) : "";
      if (pubkey && /^[0-9a-f]{64}$/.test(pubkey)) void logoutAccount(pubkey);
    }
  } catch (error) { console.warn("Could not check for interrupted sign-out", error); }
  return () => window.removeEventListener("storage", onStorage);
}
