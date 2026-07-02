import { useQuery } from '@tanstack/react-query'
import { chainlinkSocket } from '@/lib/chainlinkSocket'
import { fetchCryptoPrice } from '@/lib/cryptoPrice'
import { positionWindow } from '@/lib/positionWindow'
import { outcomeSide } from '@/components/common/OutcomeBadge'
import { useChainlinkHistory } from '@/hooks/useChainlinkHistory'
import type { Position } from '@/lib/api'

/**
 * Resolved mark (1 = won, 0 = lost) for a settling position — the window has
 * ended, the book is empty, but the outcome is already determined by the
 * resolution price vs the strike. Without this the row freezes on the last
 * pre-close quote and shows phantom P&L until the Data API indexes resolution.
 *
 * Strike/final come from the Chainlink boundary ticks when the buffer covers
 * the window, else from the crypto-price window API (handles app opened after
 * the window ended, and coins without a Chainlink stream). Returns null while
 * neither source can answer yet — callers keep the frozen fallback.
 */
export function useSettlingMark(position: Position): number | null {
  const win = positionWindow(position.eventSlug)
  const ended = win != null && win.endMs <= Date.now()

  // Subscribe so the mark re-evaluates as the boundary tick lands post-close.
  useChainlinkHistory(ended ? win.pair : null, win?.startMs ?? 0)

  const chainStrike =
    ended && win.pair ? chainlinkSocket.strikeAtBoundary(win.pair, win.startMs, win.rolling) : null
  const chainFinal =
    ended && win.pair ? chainlinkSocket.firstPriceAtOrAfter(win.pair, win.endMs, 120_000) : null

  const needApi = ended && (chainStrike == null || chainFinal == null)
  const query = useQuery({
    queryKey: win
      ? (['settlingWindow', win.symbol, win.startMs, win.endMs] as const)
      : (['settlingWindow', 'none'] as const),
    queryFn: () =>
      fetchCryptoPrice(
        win!.symbol,
        new Date(win!.startMs).toISOString(),
        new Date(win!.endMs).toISOString(),
      ),
    enabled: needApi,
    refetchInterval: (q) => {
      if (q.state.status === 'error') return 10_000
      if (q.state.data?.completed) return false
      return 3_000
    },
    staleTime: 60_000,
    retry: 2,
  })

  if (!ended) return null

  const apiOpen = query.data && query.data.openPrice > 0 ? query.data.openPrice : null
  const apiClose =
    query.data?.completed && query.data.closePrice > 0 ? query.data.closePrice : null

  const strike = chainStrike ?? apiOpen
  const final = chainFinal ?? apiClose
  if (strike == null || final == null) return null

  const side = outcomeSide(position.outcome)
  const won = final > strike ? side === 'up' : side === 'down'
  return won ? 1 : 0
}
