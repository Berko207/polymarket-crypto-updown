import { ApiAuthError, authFetch } from './apiAuth'

export interface AccountStatusResponse {
  configured: boolean
  canTrade?: boolean
  address?: string
  funderAddress?: string
  suggestedFunderAddress?: string | null
  funderMismatch?: boolean
  signatureType?: number
  usdcBalance?: number
  openOrderCount?: number
  walletSetupIssue?: string | null
  error?: string
  message?: string
}

export interface PlaceOrderRequest {
  tokenId: string
  side: 'BUY' | 'SELL'
  orderType?: 'market' | 'limit'
  /** USDC to spend (market buy) */
  amount?: number
  price?: number
  size?: number
}

export const MIN_BUY_USD = 1

export interface PlaceOrderResponse {
  success: boolean
  orderId?: string
  status?: string
  error?: string
}

export interface OpenOrder {
  id: string
  side: string
  outcome: string
  price: number
  originalSize: number
  sizeMatched: number
  sizeRemaining: number
  status: string
  assetId: string
  createdAt: number
}

export interface Position {
  tokenId: string
  outcome: string
  size: number
  avgPrice: number
  currentPrice: number
  initialValue?: number
  currentValue?: number
  cashPnl?: number
  percentPnl?: number
  title: string
  eventSlug: string
  redeemable: boolean
}

export async function fetchAccountStatus(): Promise<AccountStatusResponse> {
  const res = await authFetch('/api/account')
  if (!res.ok) throw new Error(`Account check failed (${res.status})`)
  return res.json() as Promise<AccountStatusResponse>
}

export async function fetchOpenOrders(): Promise<OpenOrder[]> {
  const res = await authFetch('/api/open-orders')
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Open orders failed (${res.status})`)
  }
  const data = (await res.json()) as { orders: OpenOrder[] }
  return data.orders
}

export async function fetchPositions(options?: {
  upTokenId?: string | null
  downTokenId?: string | null
}): Promise<Position[]> {
  const params = new URLSearchParams()
  if (options?.upTokenId) params.set('upToken', options.upTokenId)
  if (options?.downTokenId) params.set('downToken', options.downTokenId)
  const qs = params.toString()

  const res = await authFetch(`/api/positions${qs ? `?${qs}` : ''}`)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Positions failed (${res.status})`)
  }
  const data = (await res.json()) as { positions: Position[] }
  return data.positions
}

export async function cancelOrder(orderId: string): Promise<void> {
  const res = await authFetch(`/api/open-orders?orderId=${encodeURIComponent(orderId)}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `Cancel failed (${res.status})`)
  }
}

export async function placeOrder(body: PlaceOrderRequest): Promise<PlaceOrderResponse> {
  const res = await authFetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const data = (await res.json()) as PlaceOrderResponse
  if (!res.ok) {
    throw new Error(data.error ?? `Order failed (${res.status})`)
  }
  return data
}

export function truncateAddress(address: string): string {
  if (address.length < 10) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export { ApiAuthError }
