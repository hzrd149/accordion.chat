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

This is a **React 19 + TypeScript + Vite** single-page app, currently the starter scaffold (`src/App.tsx` is the Vite/React welcome page). The entry point is `src/main.tsx`, which mounts `<App />` into `#root` under `<StrictMode>`. Static assets served from the web root live in `public/`; imported assets live in `src/assets/`.

### Nostr intent

The project is pre-wired to build a **Nostr client**, even though no Nostr code exists yet. This is the key non-obvious fact about the repo:

- `.mcp.json` enables two MCP servers (both enabled in `.claude/settings.local.json`):
  - **applesauce** (`https://mcp.applesauce.build/mcp`) — docs/examples for the applesauce reactive Nostr SDK (RxJS + a single in-memory EventStore).
  - **nostr** (`@nostrbook/mcp`) — reference for Nostr protocol, NIPs, and event kinds.
- When implementing Nostr features, use the **`applesauce` skill** and these MCP servers rather than guessing at NIP/event/relay APIs.

### TypeScript project layout

Uses TypeScript project references (`tsconfig.json` → `tsconfig.app.json` + `tsconfig.node.json`). Bundler mode is strict: `verbatimModuleSyntax` is on, so use `import type` for type-only imports; `noUnusedLocals`/`noUnusedParameters` are enforced and will fail the build. `erasableSyntaxOnly` disallows runtime TS constructs (enums, parameter properties).
