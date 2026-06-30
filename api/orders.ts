import type { VercelRequest, VercelResponse } from '@vercel/node'
import { fetchUsdcBalance, formatOrderError, placeLimitOrder, placeMarketOrder, MIN_BUY_USD } from './_lib/clob.js'
import { getMaxOrderCost, getMaxOrderSize, guardTradingApi, rateLimit } from './_lib/auth.js'
import { requireCanPlaceOrders, requireConfigured, requireWalletReady } from './_lib/guards.js'

function readJsonBody(req: VercelRequest): Record<string, unknown> {
  if (req.body == null || req.body === '') return {}
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return req.body as Record<string, unknown>
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!guardTradingApi(req, res)) return
  if (!requireConfigured(res)) return
  if (!requireCanPlaceOrders(res)) return
  if (!requireWalletReady(res)) return
  if (!rateLimit(req, res, { limit: 20, key: 'place-order' })) return

  try {
    const body = readJsonBody(req)
    const tokenId = String(body.tokenId ?? '').trim()
    const side = body.side === 'SELL' ? 'SELL' : 'BUY'
    const orderType = body.orderType === 'limit' ? 'limit' : 'market'
    const price = Number(body.price)
    const size = Number(body.size)
    const amount = Number(body.amount)

    if (!tokenId) {
      return res.status(400).json({ error: 'tokenId is required' })
    }

    if (orderType === 'market') {
      const marketAmount =
        Number.isFinite(amount) && amount > 0
          ? amount
          : side === 'BUY' && Number.isFinite(price) && Number.isFinite(size)
            ? price * size
            : side === 'SELL' && Number.isFinite(size)
              ? size
              : NaN

      if (!Number.isFinite(marketAmount) || marketAmount <= 0) {
        return res.status(400).json({ error: side === 'BUY' ? 'amount (USDC) is required' : 'size (shares) is required' })
      }

      if (side === 'BUY' && marketAmount < MIN_BUY_USD) {
        return res.status(400).json({ error: `Minimum buy size is $${MIN_BUY_USD.toFixed(2)}` })
      }

      const maxSize = getMaxOrderSize()
      if (side === 'SELL' && marketAmount > maxSize) {
        return res.status(400).json({ error: `size exceeds max (${maxSize} shares)` })
      }

      const maxCost = getMaxOrderCost()
      if (side === 'BUY' && marketAmount > maxCost) {
        return res.status(400).json({ error: `order cost $${marketAmount.toFixed(2)} exceeds max $${maxCost.toFixed(2)}` })
      }

      const marketPrice =
        Number.isFinite(price) && price > 0 && price < 1 ? price : undefined

      console.info('[orders] market', {
        side,
        amount: marketAmount,
        price: marketPrice,
        tokenId: tokenId.slice(0, 12),
      })
      const result = await placeMarketOrder({
        tokenId,
        side,
        amount: marketAmount,
        price: marketPrice,
        orderType: 'market',
      })
      return res.status(200).json(result)
    }

    if (!Number.isFinite(price) || price <= 0 || price >= 1) {
      return res.status(400).json({ error: 'price must be between 0 and 1 (exclusive)' })
    }
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(400).json({ error: 'size must be a positive number of shares' })
    }

    if (side === 'BUY' && price * size < MIN_BUY_USD) {
      return res.status(400).json({
        error: `Minimum buy size is $${MIN_BUY_USD.toFixed(2)} (currently $${(price * size).toFixed(2)})`,
      })
    }

    const maxSize = getMaxOrderSize()
    if (size > maxSize) {
      return res.status(400).json({ error: `size exceeds max (${maxSize} shares)` })
    }

    const estCost = price * size
    const maxCost = getMaxOrderCost()
    if (side === 'BUY' && estCost > maxCost) {
      return res.status(400).json({ error: `order cost $${estCost.toFixed(2)} exceeds max $${maxCost.toFixed(2)}` })
    }

    if (side === 'BUY') {
      const usdcBalance = await fetchUsdcBalance()
      if (estCost > usdcBalance) {
        return res.status(400).json({
          error: `insufficient USDC (need $${estCost.toFixed(2)}, have $${usdcBalance.toFixed(2)})`,
        })
      }
    }

    console.info('[orders] limit', { side, price, size, tokenId: tokenId.slice(0, 12) })
    const result = await placeLimitOrder({ tokenId, side, price, size, orderType: 'limit' })
    return res.status(200).json(result)
  } catch (error) {
    const { message, status } = formatOrderError(error)
    return res.status(status).json({ error: message })
  }
}
