// Applesauce singletons — one EventStore and one RelayPool for the whole app.

import { EventStore } from "applesauce-core";
import { RelayPool } from "applesauce-relay";
import { AccountManager } from "applesauce-accounts";
import { ExtensionAccount, PrivateKeyAccount, ReadonlyAccount } from "applesauce-accounts/accounts";

export const eventStore = new EventStore();
export const pool = new RelayPool();

export const accounts = new AccountManager();
accounts.registerType(PrivateKeyAccount);
accounts.registerType(ExtensionAccount);
accounts.registerType(ReadonlyAccount);

// Persist accounts across reloads.
const STORAGE_KEY = "concord:accounts";
const ACTIVE_KEY = "concord:active";

export function loadAccounts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      accounts.fromJSON(JSON.parse(raw));
      const active = localStorage.getItem(ACTIVE_KEY);
      if (active && accounts.getAccount(active)) accounts.setActive(active);
    }
  } catch (err) {
    console.warn("failed to load accounts", err);
  }
}

export function persistAccounts() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts.toJSON()));
    const active = accounts.active;
    if (active) localStorage.setItem(ACTIVE_KEY, active.id);
  } catch (err) {
    console.warn("failed to persist accounts", err);
  }
}

accounts.accounts$.subscribe(() => persistAccounts());
accounts.active$.subscribe(() => persistAccounts());
