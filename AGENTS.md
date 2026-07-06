# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager is **pnpm** (see `pnpm-lock.yaml`).

- `pnpm dev` — start the Vite dev server with HMR
- `pnpm build` — type-check all projects (`tsc -b`) then produce a production build (`vite build`)
- `pnpm lint` — run ESLint over the repo
- `pnpm preview` — serve the production build locally

There is no test runner configured yet.

## Architecture

This is a **React 19 + TypeScript + Vite** single-page app implementing a **Concord** client — Discord-style, end-to-end-encrypted communities over Nostr (spec in `refs/concord/`, a git submodule). Nostr I/O goes through the **applesauce** SDK. The entry point is `src/main.tsx`, which wraps `<App />` in `EventStoreProvider` + `AccountsProvider`.

### Layout

- `src/lib/bytes.ts` — hex/byte/base64url helpers.
- `src/concord/` — the protocol core, UI-agnostic and unit-testable:
  - `crypto.ts` — CORD-02 Appendix A derivations (HKDF, `group_key`, `scalar_normalize`, `community_id`, `edition_hash`, locators). Uses `@noble/hashes`/`@noble/curves` (v2 — import subpaths carry `.js`, e.g. `@noble/hashes/hkdf.js`).
  - `stream.ts` — CORD-01 wrap/seal/rumor envelope (`createStreamEvent`/`decodeStreamEvent`), NIP-44 self-ECDH via `nostr-tools`.
  - `control.ts` (edition folding + roster), `guestbook.ts` (membership), `permissions.ts`, `community.ts` (key derivation + genesis), `editions.ts`, `chat.ts`, `invite.ts` (CORD-05 link codec), `types.ts`.
  - `client.ts` — `ConcordClient`, the reactive engine: subscribes planes via `pool.subscription`, decodes + folds into RxJS `BehaviorSubject`s, publishes optimistically (local echo first, relay in background). One instance per logged-in account.
- `src/nostr.ts` — the single `EventStore`, `RelayPool`, and `AccountManager` (persisted to localStorage).
- `src/app/` — React UI (Discord-style shell in `App.tsx`, `modals.tsx`, `Login.tsx`, `context.tsx`, `theme.css`).
- `scripts/selftest.ts` — protocol round-trip/interop test. Run: `node_modules/.bin/esbuild scripts/selftest.ts --bundle --platform=node --format=cjs --outfile=/tmp/t.cjs && node /tmp/t.cjs`.
- `scripts/drive.mjs` / `drive2.mjs` — puppeteer-core browser drivers (single-user flow; two-user E2E over real relays). Need a running `pnpm dev` and `/usr/bin/google-chrome`.

### Nostr references

- `.mcp.json` enables two MCP servers: **applesauce** (`https://mcp.applesauce.build/mcp`) and **nostr** (`@nostrbook/mcp`). Use the **`applesauce` skill** and these servers rather than guessing at NIP/event/relay APIs.
- Relays must serve kind `1059` by author without enforcing NIP-59's `p`-tag guard (Concord reverses the wrap); `relay.damus.io` and `nos.lol` work.

### TypeScript project layout

Uses TypeScript project references (`tsconfig.json` → `tsconfig.app.json` + `tsconfig.node.json`). Bundler mode is strict: `verbatimModuleSyntax` is on, so use `import type` for type-only imports; `noUnusedLocals`/`noUnusedParameters` are enforced and will fail the build. `erasableSyntaxOnly` disallows runtime TS constructs (enums, parameter properties).
