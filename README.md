# Appcordion

An **Appcordion** client for the Concord protocol — Discord-style, end-to-end-encrypted communities over [Nostr](https://nostr.com). Create or join communities, organize them into channels, chat in real time, react/reply/edit/delete messages, manage roles and members, and invite people with a link — all encrypted, with no central server.

Built with **React 19 + TypeScript + Vite**. Nostr I/O goes through the [applesauce](https://hzrd149.github.io/applesauce/) SDK. The protocol spec lives in `refs/concord/` (a git submodule).

## Features

- **Communities** — create your own (you're the owner forever) or join with an invite link.
- **Channels** — public (`#`) and private (`🔒`, its own key; only role-holders can read).
- **Chat** — send, reply, edit, delete, and react to messages, with optimistic local echo.
- **Roles & permissions** — CORD-04 permission bits (manage roles/channels/metadata, kick, ban, manage messages, create invites, and more).
- **Members** — grant roles, kick, ban/unban.
- **End-to-end encrypted** — all traffic is Nostr kind-1059 giftwraps at derived addresses; invite links carry no keys.
- **Offline-friendly** — a per-community localStorage cache of decoded rumors rehydrates the control plane, channels, and membership instantly on reload, independent of relay availability.
- **Multiple sign-in options** — generate a new identity, import an `nsec`/hex key, or sign in with a NIP-07 extension.

## Getting started

Package manager is **pnpm**.

```bash
pnpm install
pnpm dev        # start the Vite dev server with HMR
```

Then open the printed local URL and either create a new identity or sign in.

### Scripts

- `pnpm dev` — start the Vite dev server with HMR.
- `pnpm build` — type-check all projects (`tsc -b`) then produce a production build (`vite build`).
- `pnpm lint` — run ESLint over the repo.
- `pnpm preview` — serve the production build locally.

## Architecture

The app is split into a UI-agnostic protocol core and a React UI.

- `src/concord/` — the protocol core, unit-testable and independent of React:
  - `crypto.ts` — CORD-02 key derivations (HKDF, `group_key`, `community_id`, `edition_hash`, locators) via `@noble/hashes`/`@noble/curves`.
  - `stream.ts` — CORD-01 wrap/seal/rumor envelope (`createStreamEvent`/`decodeStreamEvent`).
  - `control.ts`, `guestbook.ts`, `permissions.ts`, `community.ts`, `editions.ts`, `chat.ts`, `invite.ts`, `types.ts` — edition folding, membership, permissions, key derivation/genesis, chat, and the CORD-05 invite-link codec.
  - `cache.ts` — per-community localStorage cache of **decoded** rumors, rehydrated on startup.
  - `stream-auth.ts` / `relay-auth.ts` — NIP-42 auth conventions for relays that gate kind-1059 traffic.
  - `client.ts` — `ConcordClient`, the reactive engine (rehydrate → fold → subscribe → publish optimistically) over RxJS `BehaviorSubject`s. One instance per logged-in account.
- `src/nostr.ts` — the single `EventStore`, `RelayPool`, and `AccountManager` (persisted to localStorage).
- `src/app/` — the Discord-style React UI (`App.tsx`, `modals.tsx`, `Login.tsx`, `context.tsx`, `theme.css`). Icons are from [lucide-react](https://lucide.dev).
- `src/lib/bytes.ts` — hex/byte/base64url helpers.
- `scripts/` — a protocol round-trip self-test (`selftest.ts`) plus puppeteer-based browser drivers for end-to-end testing over real relays.

### Relay requirements

Relays must serve kind `1059` by author without enforcing NIP-59's `p`-tag guard (Concord reverses the wrap). `relay.damus.io` and `nos.lol` work.

## Testing

There is no unit-test runner configured yet. The closest thing is the protocol round-trip in `scripts/selftest.ts`, which should be run after touching anything in `src/concord/`:

```bash
node_modules/.bin/esbuild scripts/selftest.ts --bundle --platform=node --format=cjs --outfile=/tmp/t.cjs && node /tmp/t.cjs
```

The `scripts/*.mjs` puppeteer drivers exercise real end-to-end flows (single/two-user chat, channel cache survival, NIP-42-gated relays) and require `pnpm dev` running plus a local Chrome.
