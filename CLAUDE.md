# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> `README.md` is the stock Vite template — ignore it. The real docs are `.env.example` and the code.

## What this is

A React 19 + Vite 8 single-page app that displays Polymarket "crypto up/down" market odds and lets a **single operator** place/cancel orders. Deployed on Vercel as a static SPA plus serverless functions under `api/`. The UI is a **pro multi-market dashboard** (watchlist + focused market + portfolio) styled with **Tailwind v4 + shadcn/ui**. Server state is **TanStack Query** (`src/queries/`); UI/selection/theme state is a **Zustand** store (`src/store/ui.ts`) persisted to `localStorage`. There is no database.

## Commands

```bash
pnpm install
pnpm dev          # Vite + local API — loads .env.local, no Vercel CLI
pnpm dev:vercel   # optional: vercel dev (parity with production routing)
pnpm dev:vite     # vite only (no /api — mostly broken)
pnpm build        # tsc -b && vite build -> dist/
pnpm lint         # oxlint (not ESLint)
pnpm preview      # preview the production build
```

**Use `pnpm dev` for local work.** It runs the browser (Vite) and the same `api/` handlers on your machine, reading secrets from `.env.local`. Credentials never enter the browser bundle. There is no test runner. `tsc -b` uses project references: `tsconfig.app.json` (browser `src`), `tsconfig.node.json` (vite config), and `api/tsconfig.json` (the only one with `strict: true`).

## Architecture

Three layers with a hard browser/server split:

1. **Browser SPA** (`src/`) — React in StrictMode, single `AppShell` (`src/App.tsx`) wrapped in `QueryClientProvider` (`src/main.tsx`), no router (`vercel.json` rewrites all non-`/api/` paths to `/index.html`). Layout = `WatchlistPanel` + `MarketDetail` + `PortfolioPanel`; feature components live in `src/components/{watchlist,market,portfolio,account,layout,common,dialogs}`, vendored shadcn primitives in `src/components/ui/`. Tailwind theme/tokens in `src/styles/globals.css` (dark default via `.dark`, light via `:root`).
2. **Client data layer** — `src/queries/` (TanStack Query hooks + mutations), `src/store/ui.ts` (Zustand), `src/lib/` (network logic + helpers), `src/hooks/` (`useTokenQuotes`, `useOrderActions`, `useThemeSync`). Hits three backends (below).
3. **Vercel serverless functions** (`api/*.ts`, `@vercel/node`, 30s max) — the **only** place Polymarket secret credentials live. Shared helpers in `api/_lib/` (`auth.ts`, `clob.ts` (cached client), `env.ts`, `guards.ts`, `positions.ts`, `wallet.ts`).

**The browser never sees Polymarket credentials.** Market discovery, parsing, countdown, live WS pricing, and update-mode logic run in the browser; anything needing the API key/secret/passphrase or private key (signing orders, reading balance/open orders) runs server-side only. Only `VITE_`-prefixed vars reach the bundle.

### Three data paths
- **Public market data** → browser fetches `/api/gamma/...`, a catch-all proxy (`api/gamma/[...path].ts`) that forwards to `gamma-api.polymarket.com` with edge caching (`s-maxage=5`). First path segment is allowlisted (`events`/`markets`/`series`/…); traversal/absolute paths are rejected. Same-origin in dev and prod; avoids CORS. No auth.
- **Live prices** → the browser opens **one** multiplexed WebSocket to the CLOB via the singleton `src/lib/clobSocket.ts` (`wss://ws-subscriptions-clob.polymarket.com/ws/market`); every consumer (watchlist, focused market, portfolio) subscribes its tokens through `useTokenQuotes` and shares that socket. Handles `book`/`price_change`/`best_bid_ask`/`last_trade_price`; display price is the bid/ask midpoint with fallbacks.
- **Trading/account** → browser calls own functions `/api/account`, `/api/orders`, `/api/open-orders`, `/api/positions`, `/api/warm` through TanStack Query hooks/mutations (`src/queries/`) over `authFetch` (`src/lib/apiAuth.ts` + `api.ts`). Server builds a cached `ClobClient` (`api/_lib/clob.ts`) and places FOK market / GTC limit orders. **Market buys** price from the live CLOB book at submit (`calculateMarketPrice` + 5% buffer) — do not cap with stale client quotes. `/api/warm` prefetches tick/neg-risk/fee metadata when a tradeable market is focused. Without `POLY_PRIVATE_KEY` the signer is absent and order/cancel calls throw — the deployment is read-only (balance/open orders work, signing physically cannot).

### App-level API auth (not user-level)
`APP_API_SECRET` (server) is a single shared secret. If set, the trading/account endpoints require `Authorization: Bearer <secret>`; **if unset, the API is wide open** (`api/_lib/auth.ts`). The client gets the secret from build-time `VITE_APP_API_SECRET` or a value entered in the `ApiUnlock` gate and stored in `localStorage`; `/api/auth-config` tells the client whether the gate is needed. This is a personal-dashboard design, not multi-tenant.

### Update modes (`src/lib/updateMode.ts`; selection in the Zustand store, resolved via `useUpdateConfig`)
- **live** = raw WS firehose to UI. **balanced** = WS but UI updates throttled to a chosen interval (`useTokenQuotes` coalesces with a trailing-edge timer). **saver** = WS off, 30s REST polling. Market metadata is polled via TanStack Query `refetchInterval` (`useMarketQuery`/`useLiveMarket`, `useWatchlistQuery`); WS quotes overlay the polled snapshot (`mergeLiveQuotes`). The focused market and its watchlist row share a query key, so they dedupe into one request.

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
