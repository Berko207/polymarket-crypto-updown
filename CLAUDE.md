# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> `README.md` is the stock Vite template — ignore it. The real docs are `.env.example` and the code.

## What this is

A React 19 + Vite 8 single-page app that displays Polymarket "crypto up/down" market odds and lets a **single operator** place/cancel GTC limit orders. Deployed on Vercel as a static SPA plus serverless functions under `api/`. State is local React state + `localStorage`; there is no database.

## Commands

```bash
pnpm install
pnpm dev          # vite only — api/ functions DON'T run, so /api/* (incl. gamma proxy) 404s
pnpm dev:local    # vercel dev — runs Vite + api/ functions locally, loads .env.local
pnpm build        # tsc -b && vite build -> dist/
pnpm lint         # oxlint (not ESLint)
pnpm preview      # preview the production build
```

**Use `pnpm dev:local` for almost all work.** Plain `vite` is mostly non-functional because even public market data is fetched through the `/api/gamma` proxy. There is no test runner. `tsc -b` uses project references: `tsconfig.app.json` (browser `src`), `tsconfig.node.json` (vite config), and `api/tsconfig.json` (the only one with `strict: true`).

## Architecture

Three layers with a hard browser/server split:

1. **Browser SPA** (`src/`) — React in StrictMode, single `AppShell` (`src/App.tsx`), no router (`vercel.json` rewrites all non-`/api/` paths to `/index.html`).
2. **Client lib** (`src/lib/`) — all network logic, hitting three different backends (below).
3. **Vercel serverless functions** (`api/*.ts`, `@vercel/node`, 30s max) — the **only** place Polymarket secret credentials live. Shared helpers in `api/_lib/`.

**The browser never sees Polymarket credentials.** Market discovery, parsing, countdown, live WS pricing, and update-mode logic run in the browser; anything needing the API key/secret/passphrase or private key (signing orders, reading balance/open orders) runs server-side only. Only `VITE_`-prefixed vars reach the bundle.

### Three data paths
- **Public market data** → browser fetches `/api/gamma/...`, a catch-all proxy (`api/gamma/[...path].ts`) that forwards to `gamma-api.polymarket.com` with edge caching (`s-maxage=5`). Same-origin in dev and prod; avoids CORS. No auth.
- **Live prices** → browser opens a WebSocket **directly** to the CLOB (`src/lib/clobWs.ts`, `wss://ws-subscriptions-clob.polymarket.com/ws/market`); no server involved. Handles `book`/`price_change`/`best_bid_ask`/`last_trade_price`; display price is the bid/ask midpoint with fallbacks.
- **Trading/account** → browser calls own functions `/api/account`, `/api/orders`, `/api/open-orders` via `authFetch` (`src/lib/apiAuth.ts` + `api.ts`). Server builds a `ClobClient` (`api/_lib/clob.ts`) and places GTC limit orders. Without `POLY_PRIVATE_KEY` the signer is a stub that throws — the deployment is read-only (balance/open orders work, signing physically cannot).

### App-level API auth (not user-level)
`APP_API_SECRET` (server) is a single shared secret. If set, the trading/account endpoints require `Authorization: Bearer <secret>`; **if unset, the API is wide open** (`api/_lib/auth.ts`). The client gets the secret from build-time `VITE_APP_API_SECRET` or a value entered in the `ApiUnlock` gate and stored in `localStorage`; `/api/auth-config` tells the client whether the gate is needed. This is a personal-dashboard design, not multi-tenant.

### Update modes (`src/lib/updateMode.ts`, persisted to localStorage)
- **live** = raw WS firehose to UI. **balanced** = WS but UI updates throttled to a chosen interval (`useLivePrices` coalesces with a trailing-edge timer). **saver** = WS off, 30s REST polling. Initial mode is auto-suggested from `navigator.connection`. Metadata polling at `pollMs` (30s) runs in all modes (`useMarket`), with a rollover timer that reloads right after each countdown target elapses; WS quotes are an overlay on the polled snapshot.

## Conventions & gotchas

- **Market discovery is slug-guessing, not list-querying.** `src/lib/slugs.ts` deterministically builds candidate event slugs from the current time (timestamp buckets + ET date strings) and tries offsets `[0,-1,+1,+2]`; `fetchMarketBySlugs` picks the first live in-window one. Deliberately avoids stale series lists but is brittle to Polymarket changing slug conventions. `config.ts` `SERIES_SLUGS` has deliberate holes (not all coin×timeframe combos exist).
- **Gamma fields `outcomes`/`outcomePrices`/`clobTokenIds` are JSON-encoded strings** — parse with `parseJsonArray`. Up/Down mapping is by outcome name with positional fallback.
- The real measurement-window start is derived in `getWindowStart` (from `startTime`/`eventStartTime`/a unix suffix in the slug), **not** gamma's `startDate` (which is market-creation time).
- `bestBidDown`/`bestAskDown` are never populated from REST (always null) — only the WebSocket fills the Down book.
- **Trading guards are server-enforced — never trust client validation.** `POLY_TRADING_ENABLED=false/0` → 503; size/cost caps (`POLY_MAX_ORDER_SIZE`, `POLY_MAX_ORDER_COST`) and a live USDC-balance check live in `api/orders.ts`. Rate limiting (`api/_lib/auth.ts`) is in-memory per instance — best-effort only, resets on cold start.
- `pnpm-workspace.yaml` is not a monorepo; it only sets `allowBuilds: esbuild: false`.

## Environment variables (`.env.example`)

- **Server-only secrets** (Vercel project settings / `.env.local`): `POLY_ADDRESS`, `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`, `POLY_SIGNATURE_TYPE`, `POLY_FUNDER_ADDRESS`, `POLY_PRIVATE_KEY`, `APP_API_SECRET`, `POLY_TRADING_ENABLED`, `POLY_MAX_ORDER_SIZE`, `POLY_MAX_ORDER_COST`.
- **Public (baked into bundle):** `VITE_APP_API_SECRET` only — the client copy of the shared secret, for personal dashboards.
