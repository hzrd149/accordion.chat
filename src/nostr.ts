// Applesauce singletons — one EventStore and one RelayPool for the whole app.

// Side-effect: registers NIP-44 hidden-content decryption for the self-encrypted
// Community/Invite lists (13302/13303) and the User.concord* casts. Must run
// before any list decrypt, so import it here where the app first loads nostr I/O.
import "applesauce-concord";
import { EventStore } from "applesauce-core";
import { persistEventsToCache } from "applesauce-core/helpers";
import { RelayPool } from "applesauce-relay";
import { createEventLoaderForStore } from "applesauce-loaders/loaders";
import { AccountManager } from "applesauce-accounts";
import { registerCommonAccountTypes } from "applesauce-accounts/accounts";
import { NostrConnectSigner } from "applesauce-signers";
import {
	ENCRYPTED_SEAL_KIND,
	PLAINTEXT_SEAL_KIND,
	COMMUNITY_LIST_KIND,
	INVITE_LIST_KIND,
} from "applesauce-concord/helpers";
import { NostrIDB } from "nostr-idb";
import type { Filter, NostrEvent } from "nostr-tools";
import { enableWasmVerification } from "./crypto-wasm";

export const eventStore = new EventStore();
export const pool = new RelayPool();

// Route Schnorr verification through nostr-wasm (WASM libsecp256k1) instead of the
// pure-JS default — the hot path when decoding the Concord planes. Non-blocking:
// the first few ms of verification use the JS fallback until the WASM is live.
void enableWasmVerification(eventStore);

// Local IndexedDB event cache (nostr-idb). Everything the EventStore ingests —
// profiles (kind 0), relay lists, and any other event the automatic loader
// fetches from relays — is mirrored here so avatars and metadata resolve
// instantly on the next load without a round-trip. This is a *cache* in front of
// the loaders, not an event database: the EventStore itself stays in-memory.
//
// Note: this is orthogonal to src/app/rumor-cache.ts, which persists the
// *decoded* Concord rumors (never raw 1059 giftwraps) per community+plane in
// their own IndexedDB databases. This cache holds the public Nostr events
// (profiles etc.) the UI renders alongside them.
// Parameterised with the signed NostrEvent shape: nostr-idb ≥5.1 defaults its
// generic to `StoredEvent` (which also admits sig-less rumors), but this public
// cache only ever holds signed events, and the EventStore loader's CacheRequest
// requires `NostrEvent[]`. The per-plane rumor cache is the sig-less counterpart.
const nostrIDB = new NostrIDB<NostrEvent>();
// start() kicks off the write-flush cycle; add()ed events queue until it runs.
// getDb() opens the database lazily, so we don't need to await this — reads and
// writes before it resolves simply see an empty cache.
void nostrIDB.start();

// Reads from the cache, used by the loaders below on an EventStore miss before
// they fall back to relays. query() resolves to [] until the DB opens.
function cacheRequest(filters: Filter[]) {
	return nostrIDB.query(filters);
}

// Mirror every event added to the EventStore into the cache (batched internally,
// ~5s). Ephemeral kinds are ignored by nostr-idb; replaceable events dedupe by
// address so only the newest survives.
persistEventsToCache(eventStore, async (events) => {
	await Promise.allSettled(events.map((event) => nostrIDB.add(event)));
});

// NIP-46 remote signers (bunker:// and nostrconnect://) talk to the remote
// signer over relays. Wire the global fallbacks so every NostrConnectSigner —
// including ones rehydrated by NostrConnectAccount.fromJSON on reload — uses our
// single RelayPool without needing methods threaded through each constructor.
NostrConnectSigner.pool = pool;

// Default relays a fresh nostrconnect:// (QR) login listens on for the remote
// signer's reply. The user can override these per-login in the UI, or globally
// via VITE_NOSTR_CONNECT_RELAYS.
export const NOSTR_CONNECT_RELAYS =
	import.meta.env.VITE_NOSTR_CONNECT_RELAYS?.split(",")
		.map((r: string) => r.trim())
		.filter(Boolean) ?? ["wss://bucket.coracle.social", "wss://relay.nsec.app"];

// Permissions we request from a remote signer. The user's own key signs the
// CORD-01 seals (SEAL_ENCRYPTED/PLAINTEXT), the self-encrypted Community/Invite
// lists (13302/13303 use NIP-44), so we also need nip44 encrypt/decrypt.
export const CONCORD_SIGNER_PERMISSIONS = [
	...NostrConnectSigner.buildSigningPermissions([
		ENCRYPTED_SEAL_KIND,
		PLAINTEXT_SEAL_KIND,
		COMMUNITY_LIST_KIND,
		INVITE_LIST_KIND,
	]),
	"nip44_encrypt",
	"nip44_decrypt",
];

// Indexer / lookup relays: aggregate kind 0 (profiles) and kind 10002 (relay
// lists) for the whole network, so profile + relay-list discovery works for any
// pubkey we have no relay hint for. Overridable via VITE_LOOKUP_RELAYS.
export const LOOKUP_RELAYS = import.meta.env.VITE_LOOKUP_RELAYS?.split(",")
	.map((r: string) => r.trim())
	.filter(Boolean) ?? ["wss://purplepag.es", "wss://index.hzrd149.com"];

// Wire the EventStore's automatic loader. On a store miss, any cast graph-walk
// (user.profile$, user.outboxes$, eventStore.event/replaceable/addressable)
// triggers this loader, which fetches by ID or address — following relay hints
// first, then falling back to the indexer relays above — and adds the result
// back to the store so reactive queries resolve.
createEventLoaderForStore(eventStore, pool, {
	cacheRequest,
	followRelayHints: true,
	lookupRelays: LOOKUP_RELAYS,
});

export const accounts = new AccountManager();
registerCommonAccountTypes(accounts);

// NIP-44 registration for the self-encrypted Community/Invite lists (13302/13303)
// is handled by applesauce-concord's register.ts (imported for its side effect at
// the top of this file), via setHiddenContentEncryptionMethod.

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
