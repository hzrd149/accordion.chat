# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`).

- `pnpm dev` — start the Vite dev server with HMR
- `pnpm build` — type-check all projects (`tsc -b`) then produce a production build (`vite build`)
- `pnpm lint` — run ESLint over the repo
- `pnpm preview` — serve the production build locally

There is no test runner configured yet. The closest thing to a test is the protocol round-trip in `scripts/selftest.ts` (see below) — run it after touching anything in `src/concord/`.

## Git workflow

**Commit after every feature or self-contained change.** Once a feature works (built/linted, and — if it touches `src/concord/` — the self-test passes), make a focused git commit before moving on. Keep commits small and scoped to one feature so history stays reviewable; don't batch unrelated changes into one commit. Do not push unless asked.

## Architecture

This is a **React 19 + TypeScript + Vite** single-page app implementing a **Concord** client — Discord-style, end-to-end-encrypted communities over Nostr (spec in `refs/concord/`, a git submodule). Nostr I/O goes through the **applesauce** SDK. The entry point is `src/main.tsx`, which wraps `<App />` in `EventStoreProvider` + `AccountsProvider`.

### Layout

- `src/lib/bytes.ts` — hex/byte/base64url helpers.
- `src/concord/` — the protocol core, UI-agnostic and unit-testable:
  - `crypto.ts` — CORD-02 Appendix A derivations (HKDF, `group_key`, `scalar_normalize`, `community_id`, `edition_hash`, locators). Uses `@noble/hashes`/`@noble/curves` (v2 — import subpaths carry `.js`, e.g. `@noble/hashes/hkdf.js`).
  - `stream.ts` — CORD-01 wrap/seal/rumor envelope (`createStreamEvent`/`decodeStreamEvent`), NIP-44 self-ECDH via `nostr-tools`.
  - `control.ts` (edition folding + roster), `guestbook.ts` (membership), `permissions.ts`, `community.ts` (key derivation + genesis, incl. `voiceKeysFor`), `editions.ts`, `chat.ts`, `invite.ts` (CORD-05 link codec), `types.ts`.
  - `voice.ts` — CORD-07 A/V: the blind-broker token flow (`signAvGrant`/`fetchAvToken`, kind-27235 NIP-98 grant signed by `voice_key.sk` so `pubkey == room`), call-presence fold + sole-claimant identity verification (§4, kind 23313 over the channel's own ephemeral wrap), and the §5 rendezvous tie-break. Voice keys (`voiceGroupKey`/`voiceMediaKey`/`voiceSenderKey`) live in `crypto.ts` and ride the *same* `(secret, epoch)` pair as the channel's Chat Plane, so they rotate on Rekey. Mirrors armada's `concord-v2/lib/voice.ts` + `derive.ts`.
  - `cache.ts` — per-community localStorage cache of **decoded** rumors (never raw 1059). Rehydrated on startup so the control plane / channels / membership survive reload instantly, independent of whether a relay re-serves the giftwraps.
  - `stream-auth.ts` — registry of the **derived stream secret keys** the client holds (control/guestbook/dissolved/next-base-rekey/channels), and `signStreamAuths(challenge, url)` producing one kind-22242 per key. Concord planes are 1059 traffic at derived addresses, and relays that gate 1059 behind NIP-42 (ditto `AUTH_KINDS=4,1059`) require *every author in a 1059 REQ* to be authenticated — so we authenticate AS each stream key (local signing, no signer prompt). Mirrors armada `concord-v2/lib/streamAuth.ts`. **Not** part of the frozen CORD spec — a relay-access convention.
  - `relay-auth.ts` — `autoAuthenticate(signer)`: watches `pool.status$` and, when a relay gates reads/writes behind auth, sends an AUTH per held stream key (via `relay.auth`) plus the user's own (`relay.authenticate`). Applesauce correlates each AUTH's OK by event id (multiple AUTHs per connection work) and *pauses* the REQ on `auth-required`, auto-retrying once `authenticated$` flips. `onStreamKeysAdded` re-answers open connections as channels fold in. Gated on `authRequiredForRead/Publish`, not the mere challenge, so relays that challenge-but-don't-require don't cause spurious prompts.
  - `client.ts` — `ConcordClient`, the reactive engine. Rehydrates from cache → folds → opens a **stable** control/guestbook/dissolved subscription plus a **dynamic** channel subscription (split so discovering a channel never tears down the control stream). Decodes + folds into RxJS `BehaviorSubject`s; publishes optimistically (local echo first, relay in background). One instance per logged-in account.
- `src/nostr.ts` — the single `EventStore`, `RelayPool`, and `AccountManager` (persisted to localStorage; persistence is gated behind `loadAccounts()` so the initial restore isn't clobbered). Registers kinds 13302/13303 for the applesauce encrypted-content cache.
- `src/app/` — React UI (Discord-style shell in `App.tsx`, `modals.tsx`, `Login.tsx`, `context.tsx`, `theme.css`).
  - `src/app/voice/` — the CORD-07 call UI (LiveKit). `CallProvider` holds the one active call and lazy-loads `VoiceRoom` (keeps the ~0.5MB `livekit-client` chunk out of boot); `VoiceRoom` builds the E2EE `Room` — LiveKit's built-in `e2ee-worker` + a custom `SenderKeyProvider extends BaseKeyProvider` (`sharedKey:false, keySize:256`, ratchet disabled) fed the externally-derived per-identity `voiceSenderKey` material (verified identities keyed, unverified given a random key so their frames never decode, §3/§7). Presence heartbeat is driven via `ConcordClient.joinVoice`/`leaveVoice`. `CallStage`/`CallBar` are the grid + controls; `brokers.ts` defaults `VITE_CONCORD_AV_SERVERS` to `https://armada.buzz` (the public Armada broker+SFU) so calls work out of the box. Mirrors armada's `PersistentVoiceRoom.tsx`. **`livekit-client` is pinned to `2.19.2` (armada's exact locked version), not floated** — the `e2ee-worker` frame crypto is version-sensitive, and `2.20.0` corrupted decoded audio+video against armada peers. Audio publish config also matches armada exactly (`AudioPresets.musicHighQuality`, `red:true`, `dtx:true`) — these ride below the E2EE frame crypto and don't affect decryption.
- `scripts/selftest.ts` — protocol round-trip/interop test. Run: `node_modules/.bin/esbuild scripts/selftest.ts --bundle --platform=node --format=cjs --outfile=/tmp/t.cjs && node /tmp/t.cjs`.
- `scripts/*.mjs` — puppeteer-core browser drivers (need `pnpm dev` + `/usr/bin/google-chrome`): `drive.mjs`/`drive2.mjs` (single/two-user over real relays), `chan-cache.mjs` (channels survive reload with a dead relay), `drive-auth.mjs` + `mock-auth-relay.mjs` (two users over a relay that requires NIP-42 AUTH to read), and `drive-voice.mjs`/`drive-voice2.mjs` (single/two-user CORD-07 calls against the live `armada.buzz` broker+SFU — pass fake media devices, assert the E2EE connection + presence roster).

### Nostr references

- `.mcp.json` enables two MCP servers: **applesauce** (`https://mcp.applesauce.build/mcp`) and **nostr** (`@nostrbook/mcp`). Use the **`applesauce` skill** and these servers rather than guessing at NIP/event/relay APIs.
- Relays must serve kind `1059` by author without enforcing NIP-59's `p`-tag guard (Concord reverses the wrap); `relay.damus.io` and `nos.lol` work.

### TypeScript project layout

Uses TypeScript project references (`tsconfig.json` → `tsconfig.app.json` + `tsconfig.node.json`). Bundler mode is strict: `verbatimModuleSyntax` is on, so use `import type` for type-only imports; `noUnusedLocals`/`noUnusedParameters` are enforced and will fail the build. `erasableSyntaxOnly` disallows runtime TS constructs (enums, parameter properties).
