# Portfolio buy flicker — diagnosis & fix (2026-07-02)

**Symptom:** buy Up/Down → position appears, blinks out, then takes many seconds to
reappear. Selling behaves fine.

## Root causes (all on master)

1. **PR #6 was never merged.** The fix for exactly this flicker
   (`worktree-fix-portfolio-buy-flicker`, commit `f544c02`) sat as an open PR, so master
   kept the broken behavior:
   - `usePlaceOrder.onSuccess` cleared the `recentFills` overlay entry on a *successful*
     buy before re-adding it. `PortfolioPanel` re-renders synchronously on that store
     (`useSyncExternalStore`), so the clear→re-remember painted an empty frame — the
     visible blink.
   - `schedulePortfolioRefetches` force-refetched positions 7× over 4s. The Data API
     hasn't indexed the fill yet at that point, so each early refetch clobbered the
     freshly patched row with stale "no position" data — the slow reappearance.

2. **Uncommitted WIP hunk in `src/queries/portfolio.ts` (main checkout, 2026-07-02)**
   re-adds `rollbackFillOptimistic` (which calls `clearRecentFill`) on successful buys —
   it re-creates the blank frame and textually conflicts with this branch.
   → Discard it: `git checkout -- src/queries/portfolio.ts`
   (the other uncommitted files — spot-divergence warnings, `quoteToPrice` spread rule —
   are unrelated and safe to keep).

3. **Doubled optimistic size (fixed in `7024060` on this branch):**
   `patchMarketHoldingsCache` applied the same fill **twice** to the focused market's
   `['positions','market',up,down]` cache — the `setQueriesData` prefix pass patched it,
   then the explicit `setQueryData` patched the already-patched rows again, so
   `mergeBuyIntoPosition` stacked the fill onto itself. A fresh 10-share buy showed as
   20 shares (and 2× cost) until the post-fill refetch corrected it.

## Fix state (this branch / PR #6)

- `f544c02` — cache-only rollback (`rollbackFillCaches`, never clears the overlay),
  `rememberRecentFill` applied last, refetch burst split (balance/orders at
  `[0,400,1200]ms`; positions once at ~2.5s).
- `7024060` — the explicit market-cache write only *seeds* the key when it isn't cached
  yet, eliminating the doubled optimistic size.
- Verified: simulation against a real TanStack `QueryClient` (old sequence → size 20 for
  a 10-share buy; new → 10, key cached and uncached), `pnpm build` (tsc -b + vite) clean,
  `oxlint` clean (pre-existing warnings only).

## Merge notes

1. Merge PR #6 to master.
2. Discard the WIP hunk in `src/queries/portfolio.ts` on master (see above).
3. If merging **PR #7** (sell thin books) first: it carries the old flicker fix
   (`ff04fb9` = cherry-pick of `f544c02`) but **not** `7024060` — merge #6 as well;
   they resolve cleanly.

## Why sells never flickered

Sells use the separate sold-hide path (`rememberRecentSell` / `soldTokens`), which master
already has, and any filled market sell hides the row unconditionally (full-close intent).

## Follow-up incident (2026-07-02): phantom size blocks the sell

**Symptom:** selling XRP Up failed with CLOB error
`not enough balance / allowance: balance: 1851850, order amount: 3700000`
while the row showed "3.70 shares · $2.00 cost".

**Mechanism:** market buys are FAK (`api/_lib/clob.ts`) and can **partial-fill**. A $2.00
buy at 54¢ only found ~$1.00 of asks, so 1.85 shares filled and the rest was cancelled.
The immediate CLOB response often omits/under-reports `fillSize`, so the client fell back
to the assume-it-all-filled estimate ($2 ÷ 0.54 = 3.70) and `mergePendingFillPositions`
kept `Math.max(chain 1.85, estimate 3.70)` for the 5-minute fill TTL. Selling the
displayed 3.70 then bounced off the CLOB's balance check — position unsellable from the UI.

**Fixes (this branch):**
- `api/orders.ts` — market SELLs clamp to the live on-chain balance (portfolio sells are
  full-close intents); a ~zero balance returns a clear 409 instead of a CLOB reject.
- `mergePendingFillPositions` — once a pending fill is >15s old (`TRUST_CHAIN_AFTER_MS`)
  and the token's chain balance has been fetched (`chainCheckedTokenIds` from
  `useTimeframeHoldingsQuery`), the overlay stops inflating size / resurrecting rows and
  only backfills cost metadata the indexer hasn't produced yet.
- Buy toast shows `≈` before the share count when the CLOB didn't report a real fill size.

**Known limitation:** a position bought on one timeframe tab isn't chain-checked while a
different tab is focused, so the inflated size can persist there until the Data API row
wins; the sell clamp still makes closing it work.
