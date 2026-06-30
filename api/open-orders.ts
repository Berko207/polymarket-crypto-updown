import type { VercelRequest, VercelResponse } from '@vercel/node'
import { cancelOpenOrder, fetchOpenOrders, formatOrderError } from './_lib/clob.js'
import { guardTradingApi } from './_lib/auth.js'
import { requireCanPlaceOrders, requireConfigured } from './_lib/guards.js'

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'GET, DELETE')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  if (!guardTradingApi(req, res)) return
  if (!requireConfigured(res)) return
  if (!requireCanPlaceOrders(res, 'manage orders')) return

  try {
    if (req.method === 'GET') {
      const orders = await fetchOpenOrders()
      return res.status(200).json({ orders })
    }

    const orderId = String(req.query.orderId ?? '').trim()
    if (!orderId) {
      return res.status(400).json({ error: 'orderId query param is required' })
    }

    console.info('[open-orders] cancel', { orderId: orderId.slice(0, 12) })
    await cancelOpenOrder(orderId)
    return res.status(200).json({ success: true })
  } catch (error) {
    const { message, status } = formatOrderError(error)
    return res.status(status).json({ error: message })
  }
}
