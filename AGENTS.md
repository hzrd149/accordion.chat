# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`).

- `pnpm dev` — start the Vite dev server with HMR
- `pnpm build` — type-check all projects (`tsc -b`) then produce a production build (`vite build`)
- `pnpm lint` — run ESLint over the repo
- `pnpm preview` — serve the production build locally

The protocol core now lives in the **`applesauce-concord`** package (linked from `../applesauce/packages/concord` via `pnpm-workspace.yaml` overrides), which carries its own vitest suite. Run it with `pnpm test:concord` after touching anything protocol-related, or when bumping the linked package.

## Git workflow

**Commit after every feature or self-contained change.** Once a feature works (built/linted, and — if it touches protocol behavior — `pnpm test:concord` passes), make a focused git commit before moving on. Keep commits small and scoped to one feature so history stays reviewable; don't batch unrelated changes into one commit. Do not push unless asked.

## Architecture

This is a **React 19 + TypeScript + Vite** single-page app implementing a **Concord** client — Discord-style, end-to-end-encrypted communities over Nostr (spec in `refs/concord/`, a git submodule). Nostr I/O goes through the **applesauce** SDK. The entry point is `src/main.tsx`, which wraps `<App />` in `EventStoreProvider` + `AccountsProvider`.

### Layout

- `src/lib/bytes.ts` — hex/byte/base64url helpers. `src/lib/image.ts` — AES-GCM encrypt/decrypt of community/chat media blobs (the plaintext never touches a server). `src/lib/blossom.ts` — ciphertext upload over `blossom-client-sdk`.
- **Protocol core: the `applesauce-concord` package** (not in this repo — linked from `../applesauce/packages/concord`). It provides CORD-01…06 crypto/stream/control/guestbook/permissions/editions/rekey/invite helpers, the CORD-07 voice-key derivations, casts/models, and the reactive client split into a thin **`ConcordClient`** manager (`{ signer, pubkey, pool, eventStore, uploader, autoUnlock }`; owns the Community/Invite lists + NIP-42 stream-key auth + a `Map<cid, ConcordCommunity>`) plus a per-community **`ConcordCommunity`** engine (all messaging/moderation/lifecycle methods, `state$`, and per-plane `channelStore(id): RumorStore`). Import helpers/kinds from `applesauce-concord/helpers`, types + client from `applesauce-concord`. Importing the package side-effect-registers NIP-44 hidden content for 13302/13303 and the `User.concord*` casts.
- **App-side glue over the package** (things the package deliberately leaves to the client):
  - `src/app/chat/fold.ts` + `useMessages.ts` — the package's `channelStore` is a raw `RumorStore`; the app folds its rumors (messages 9, reactions 7, edits 3302, deletes 5, NIP-22 comments 1111) into `ChatMessage[]`/`ThreadComment[]` via `useMessages`/`useThread` (`channelStore.timeline(...).pipe(map(fold))`). `chat/actions.ts` builds nested thread replies with `CommentFactory` (the app's threads are NIP-22 comment trees rooted on chat messages, not the package's kind-11 forum threads).
  - `src/voice/` — CORD-07 is absent from the package (its ingest funnel drops presence rumors), so voice lives here. `presence.ts` — blind-broker token flow (`signAvGrant`/`fetchAvToken`, kind-27235 grant signed by `voice_key.sk`), presence fold + sole-claimant verification, §5 rendezvous. `engine.ts` — a per-community `VoiceEngine` reimplementing `voiceKeys`/`getVoicePresence$`/`joinVoice`/`leaveVoice`: it runs its OWN ephemeral (21059) subscription at the channel address (riding the pool socket the manager already NIP-42-auths), decodes presence with the channel's `channelKeyFor` conv key, and publishes via `community.sendEvent(..., {ephemeral})` (self-reflecting its own echo, which the community filter drops). `registry.ts` — one `VoiceEngine` per community + the `useVoiceEngine` hook + GC on community removal.
  - `src/app/concord-uploader.ts` — a `ConcordUploader` adapter (encrypt via `lib/image` → upload ciphertext via `lib/blossom` → return the package `MediaAttachment`), injected into `ConcordClient` so file attachments / community images work.
  - `src/app/use-community.ts` — `useCommunity(cid)` resolves the per-community `ConcordCommunity` from the manager (re-resolving on `communities$`).
- `src/nostr.ts` — the single `EventStore`, `RelayPool`, and `AccountManager` (persisted to localStorage; persistence gated behind `loadAccounts()` so the initial restore isn't clobbered). Imports `applesauce-concord` for its register side effect and the seal/list kind constants used to build the NIP-46 signer permissions.
- `src/crypto-wasm.ts` — swaps pure-JS Schnorr verification for **nostr-wasm** (WASM libsecp256k1, ~4× faster) at startup: sets `eventStore.verifyEvent` and `setVerifyWrappedEventMethod(...)`. The wrapped-event method is the hot path — the Concord gift-wrap decoder (`getWrapSeal`) verifies a seal signature on *every* wrap decode across every plane, so it must go through applesauce-core's swappable `verifyWrappedEvent` hook (a small patch to `applesauce-concord`'s `gift-wrap.ts` routes it there). Init is non-blocking; the first few ms fall back to JS. `scripts/bench-verify.mjs` measures the speedup. Event-id hashing stays on `@noble` sync sha256 (WebCrypto's async `subtle.digest` is slower for event-sized inputs and unusable in the sync hash path).
- `src/app/` — React UI (Discord-style shell in `App.tsx`, `modals.tsx`, `Login.tsx`, `context.tsx`, `theme.css`).
  - `src/app/voice/` — the CORD-07 call UI (LiveKit). `CallProvider` holds the one active call and lazy-loads `VoiceRoom` (keeps the ~0.5MB `livekit-client` chunk out of boot); `VoiceRoom` builds the E2EE `Room` — LiveKit's built-in `e2ee-worker` + a custom `SenderKeyProvider extends BaseKeyProvider` (`sharedKey:false, keySize:256`, ratchet disabled) fed the externally-derived per-identity `voiceSenderKey` material (verified identities keyed, unverified given a random key so their frames never decode, §3/§7). Presence heartbeat is driven via the app-side `VoiceEngine.joinVoice`/`leaveVoice` (see `src/voice/`). `CallStage`/`CallBar` are the grid + controls; `brokers.ts` defaults `VITE_CONCORD_AV_SERVERS` to `https://armada.buzz` (the public Armada broker+SFU) so calls work out of the box. Mirrors armada's `PersistentVoiceRoom.tsx`. **The app is NOT wrapped in `<StrictMode>` (see `main.tsx`) — that is load-bearing for voice:** StrictMode's dev double-mount tears down + rebuilds the `Room`/`e2ee-worker` mid-handshake, leaving media E2EE half-initialized so every remote frame is silently dropped (mute/garbled audio). LiveKit's connecting-Room lifecycle can't survive a synchronous remount. **E2EE is enabled BEFORE connecting** (`setE2EEEnabled(true)` awaited, then the `LiveKitRoom` render is gated on `e2eeReady`): LiveKit turns the local frame cryptor on once, at `SignalConnected`, keyed off whether `encryptionType` is already GCM — enabling it after connect (racing the token fetch) loses that window and the cryptor never activates. `livekit-client` is pinned to `2.19.2` (armada's exact locked version; `keySize` in `KeyProviderOptions`, hence AES-256, only exists from 2.19.x). Audio publish config matches armada (`AudioPresets.musicHighQuality`, `red:true`, `dtx:true`); RED is auto-disabled by LiveKit whenever E2EE is on, so it never touches the frame crypto.
- Protocol round-trip/interop coverage now lives in the `applesauce-concord` package's own vitest suite (`pnpm test:concord`) — the old `scripts/selftest.ts`/`interop.ts` were removed with the in-repo core.
- `scripts/*.mjs` — puppeteer-core browser drivers (need `pnpm dev` + `/usr/bin/google-chrome`): `drive.mjs`/`drive2.mjs` (single/two-user over real relays), `chan-cache.mjs` (channels survive reload with a dead relay), `drive-auth.mjs` + `mock-auth-relay.mjs` (two users over a relay that requires NIP-42 AUTH to read), and `drive-voice.mjs`/`drive-voice2.mjs` (single/two-user CORD-07 calls against the live `armada.buzz` broker+SFU — pass fake media devices, assert the E2EE connection + presence roster). `drive-voice-audio.mjs` goes further: two users join, then each MEASURES the other's decoded audio via a Web Audio `AnalyserNode` tapped off the `<audio>` element (Chrome's fake device emits a tone → healthy E2EE decode shows real tonal energy; a broken decrypt shows silence/flat noise). This is the only driver that actually catches E2EE decode failures — the roster drivers pass even when audio is silently dropped.

### Nostr references

- `.mcp.json` enables two MCP servers: **applesauce** (`https://mcp.applesauce.build/mcp`) and **nostr** (`@nostrbook/mcp`). Use the **`applesauce` skill** and these servers rather than guessing at NIP/event/relay APIs.
- Relays must serve kind `1059` by author without enforcing NIP-59's `p`-tag guard (Concord reverses the wrap); `relay.damus.io` and `nos.lol` work.

### TypeScript project layout

Uses TypeScript project references (`tsconfig.json` → `tsconfig.app.json` + `tsconfig.node.json`). Bundler mode is strict: `verbatimModuleSyntax` is on, so use `import type` for type-only imports; `noUnusedLocals`/`noUnusedParameters` are enforced and will fail the build. `erasableSyntaxOnly` disallows runtime TS constructs (enums, parameter properties).
