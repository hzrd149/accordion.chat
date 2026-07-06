// Applesauce singletons — one EventStore and one RelayPool for the whole app.

import { EventStore } from "applesauce-core";
import { setEncryptedContentEncryptionMethod } from "applesauce-core/helpers";
import { RelayPool } from "applesauce-relay";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { AccountManager } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { NostrConnectSigner } from "applesauce-signers";
import { KIND } from "./concord/types";

export const eventStore = new EventStore();
export const pool = new RelayPool();

// NIP-46 remote signers (bunker:// and nostrconnect://) talk to the remote
// signer over relays. Wire the global fallbacks so every NostrConnectSigner —
// including ones rehydrated by NostrConnectAccount.fromJSON on reload — uses our
// single RelayPool without needing methods threaded through each constructor.
NostrConnectSigner.subscriptionMethod = pool.subscription.bind(pool);
NostrConnectSigner.publishMethod = pool.publish.bind(pool);

// Relays a fresh nostrconnect:// (QR) login listens on for the remote signer's
// reply. Overridable via VITE_NOSTR_CONNECT_RELAYS.
export const NOSTR_CONNECT_RELAYS = (
	import.meta.env.VITE_NOSTR_CONNECT_RELAYS?.split(",").map((r: string) => r.trim()).filter(Boolean) ?? [
		"wss://relay.nsec.app",
	]
);

// Permissions we request from a remote signer. The user's own key signs the
// CORD-01 seals (SEAL_ENCRYPTED/PLAINTEXT), the self-encrypted Community/Invite
// lists (13302/13303 use NIP-44), so we also need nip44 encrypt/decrypt.
export const CONCORD_SIGNER_PERMISSIONS = [
	...NostrConnectSigner.buildSigningPermissions([
		KIND.SEAL_ENCRYPTED,
		KIND.SEAL_PLAINTEXT,
		KIND.COMMUNITY_LIST,
		KIND.INVITE_LIST,
	]),
	"nip44_encrypt",
	"nip44_decrypt",
];

// Indexer / lookup relays: aggregate kind 0 (profiles) and kind 10002 (relay
// lists) for the whole network, so profile + relay-list discovery works for any
// pubkey we have no relay hint for. Overridable via VITE_LOOKUP_RELAYS.
export const LOOKUP_RELAYS = (
	import.meta.env.VITE_LOOKUP_RELAYS?.split(",").map((r: string) => r.trim()).filter(Boolean) ?? [
		"wss://purplepag.es",
		"wss://index.hzrd149.com",
	]
);

// Wire the EventStore's automatic loader. On a store miss, any cast graph-walk
// (user.profile$, user.outboxes$, eventStore.event/replaceable/addressable)
// triggers this loader, which fetches by ID or address — following relay hints
// first, then falling back to the indexer relays above — and adds the result
// back to the store so reactive queries resolve.
createEventLoaderForStore(eventStore, pool, {
	followRelayHints: true,
	lookupRelays: LOOKUP_RELAYS,
});

export const accounts = new AccountManager();
registerCommonAccountTypes(accounts);

// The self-encrypted Community List / Invite List use NIP-44; register so the
// applesauce encrypted-content cache (unlockEncryptedContent) knows the method.
setEncryptedContentEncryptionMethod(KIND.COMMUNITY_LIST, "nip44");
setEncryptedContentEncryptionMethod(KIND.INVITE_LIST, "nip44");

// Persist accounts across reloads.
const STORAGE_KEY = "concord:accounts";
const ACTIVE_KEY = "concord:active";

// Persistence must not run until the initial restore has happened — the
// accounts$/active$ BehaviorSubjects emit synchronously on subscribe, which
// would otherwise overwrite storage with the empty initial state before
// loadAccounts() gets to read it.
let persistReady = false;

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
	} finally {
		persistReady = true;
	}
}

export function persistAccounts() {
	if (!persistReady) return;
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(accounts.toJSON()));
		const active = accounts.active;
		if (active) localStorage.setItem(ACTIVE_KEY, active.id);
		else localStorage.removeItem(ACTIVE_KEY);
	} catch (err) {
		console.warn("failed to persist accounts", err);
	}
}

accounts.accounts$.subscribe(() => persistAccounts());
accounts.active$.subscribe(() => persistAccounts());
