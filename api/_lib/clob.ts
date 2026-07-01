import {
  ApiError,
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type TickSize,
} from '@polymarket/clob-client-v2'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import { assertWalletConfig, getPolyConfig, getWalletSetupIssue, type PolyServerConfig } from './env.js'

const CLOB_HOST = 'https://clob.polymarket.com'

function normalizePrivateKey(key: string): `0x${string}` {
  const trimmed = key.trim()
  const hex = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`
  return hex as `0x${string}`
}

function walletFromPrivateKey(privateKey: string) {
  const account = privateKeyToAccount(normalizePrivateKey(privateKey))
  return createWalletClient({
    account,
    chain: polygon,
    transport: http(),
  })
}

function toApiCreds(config: PolyServerConfig): ApiKeyCreds {
  return {
    key: config.apiKey,
    secret: config.apiSecret,
    passphrase: config.apiPassphrase,
  }
}

function buildClobClient(config: PolyServerConfig): ClobClient {
  const creds = toApiCreds(config)
  const signer = config.privateKey ? walletFromPrivateKey(config.privateKey) : undefined

  return new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    // Local clock for L2 HMAC — avoids an extra GET /time round trip on every auth call.
    useServerTime: false,
    throwOnError: true,
  })
}

let cachedClient: { sig: string; client: ClobClient } | null = null

function configSignature(c: PolyServerConfig): string {
  return [c.address, c.funderAddress, c.signatureType, c.apiKey, c.privateKey ? 'pk' : 'nopk'].join('|')
}

/** Build a ClobClient, reusing a cached instance while the config is unchanged
 * (env is static per deployment) — avoids rebuilding a viem signer per request. */
export function createClobClient(config: PolyServerConfig): ClobClient {
  const sig = configSignature(config)
  if (cachedClient?.sig === sig) return cachedClient.client
  const client = buildClobClient(config)
  cachedClient = { sig, client }
  return client
}

export function getClobClient(): ClobClient | null {
  const config = getPolyConfig()
  if (!config) return null
  return createClobClient(config)
}

function requirePrivateKey(action: string): PolyServerConfig {
  const config = getPolyConfig()
  if (!config?.privateKey) throw new Error(`POLY_PRIVATE_KEY is required to ${action}`)
  return config
}

const ALLOWANCE_TTL_MS = 60_000
let allowanceSyncedAt = 0
let allowanceSyncPromise: Promise<void> | null = null

/** Deposit-wallet flow: sync USDC allowance with CLOB (slow — cache ~60s per instance). */
async function ensureCollateralAllowance(client: ClobClient): Promise<void> {
  if (Date.now() - allowanceSyncedAt < ALLOWANCE_TTL_MS) return

  if (!allowanceSyncPromise) {
    allowanceSyncPromise = client
      .updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
      .then(() => {
        allowanceSyncedAt = Date.now()
      })
      .finally(() => {
        allowanceSyncPromise = null
      })
  }
  await allowanceSyncPromise
}

function usesDepositWalletAllowance(config: PolyServerConfig): boolean {
  return config.signatureType === SignatureTypeV2.POLY_1271
}

/** Shared pre-flight for placing an order: client + (1271) allowance + market params. */
async function prepareOrder(
  config: PolyServerConfig,
  tokenId: string,
  hint?: { tickSize: TickSize; negRisk: boolean } | null,
) {
  const client = createClobClient(config)
  const [, params] = await Promise.all([
    usesDepositWalletAllowance(config) ? ensureCollateralAllowance(client) : Promise.resolve(),
    marketParams(client, tokenId, hint),
    // Populates feeInfos so createMarketOrder skips _ensureMarketInfoCached round trips.
    client.getFeeExponent(tokenId).catch(() => {}),
  ])
  return { client, ...params }
}

/**
 * Prefetch tick size, neg-risk, fee metadata, and (when needed) collateral allowance so
 * the first click on Buy/Sell skips cold CLOB lookups.
 */
export async function warmOrderPath(tokenIds: string[]): Promise<void> {
  const config = getPolyConfig()
  if (!config?.privateKey || getWalletSetupIssue(config)) return

  const client = createClobClient(config)
  const ids = [...new Set(tokenIds.map((id) => id.trim()).filter(Boolean))]
  if (!ids.length) return

  await Promise.all([
    usesDepositWalletAllowance(config) ? ensureCollateralAllowance(client) : Promise.resolve(),
    ...ids.flatMap((tokenId) => [
      marketParams(client, tokenId),
      client.getFeeExponent(tokenId).catch(() => {}),
    ]),
  ])
}

/** Parse CLOB making/taking amounts (micro-units) into human fill price + size. */
function parseOrderFill(
  side: 'BUY' | 'SELL',
  record: Record<string, unknown> | null,
): Pick<PlaceOrderResult, 'fillPrice' | 'fillSize'> {
  const make = Number(record?.makingAmount)
  const take = Number(record?.takingAmount)
  if (!Number.isFinite(make) || !Number.isFinite(take) || make <= 0 || take <= 0) return {}

  const makeN = make / 1e6
  const takeN = take / 1e6

  if (side === 'BUY') {
    const fillSize = takeN
    const fillPrice = fillSize > 0 ? makeN / fillSize : undefined
    return fillPrice != null && fillPrice > 0 && fillPrice < 1 ? { fillSize, fillPrice } : {}
  }

  const fillSize = makeN
  const fillPrice = fillSize > 0 ? takeN / fillSize : undefined
  return fillPrice != null && fillPrice > 0 && fillPrice < 1 ? { fillSize, fillPrice } : {}
}

function unwrapOrderResult(response: unknown, side?: 'BUY' | 'SELL'): PlaceOrderResult {
  const record = response as Record<string, unknown> | null
  return {
    success: true,
    orderId: typeof record?.orderID === 'string' ? record.orderID : undefined,
    status: typeof record?.status === 'string' ? record.status : undefined,
    ...(side ? parseOrderFill(side, record) : {}),
  }
}

export interface AccountSnapshot {
  address: string
  funderAddress: string
  signatureType: number
  usdcBalance: number
  openOrderCount: number
  canTrade: boolean
  walletSetupIssue: string | null
}

export interface PlaceOrderParams {
  tokenId: string
  side: 'BUY' | 'SELL'
  price?: number
  size?: number
  amount?: number
  orderType?: 'market' | 'limit'
  /** Client-supplied gamma metadata; used only on a cache miss (see {@link marketParams}). */
  tickSize?: number
  negRisk?: boolean
}

const VALID_TICK_SIZES: TickSize[] = ['0.1', '0.01', '0.001', '0.0001']

/** Coerce a numeric (gamma) or string tick size to the client's TickSize union, or null. */
function normalizeTickSize(value: number | undefined): TickSize | null {
  if (value == null || !Number.isFinite(value)) return null
  return VALID_TICK_SIZES.find((t) => Math.abs(Number(t) - value) < 1e-9) ?? null
}

/** A complete client-supplied metadata hint, or null when either field is missing/invalid. */
function clientMarketParamsHint(params: PlaceOrderParams): { tickSize: TickSize; negRisk: boolean } | null {
  const tickSize = normalizeTickSize(params.tickSize)
  if (!tickSize || typeof params.negRisk !== 'boolean') return null
  return { tickSize, negRisk: params.negRisk }
}

export interface PlaceOrderResult {
  success: boolean
  orderId?: string
  status?: string
  /** Actual average fill price from CLOB making/taking amounts. */
  fillPrice?: number
  /** Shares bought or sold. */
  fillSize?: number
}

export const MIN_BUY_USD = 1

/**
 * Marketable-order price buffers. A market FOK/FAK fills at the *resting* book
 * price, so these are only the order's limit ceiling (buy) / floor (sell) — they
 * make it cross on the first shot (no slow "book moved" retry) WITHOUT changing
 * the price you actually pay in a normal book. You only pay the buffer if a thin
 * book makes the order sweep — and that's bounded by POLY_MAX_ORDER_COST / size.
 * Whichever is larger wins: a few-cents absolute pad or a small percentage.
 */
export const MARKET_SLIPPAGE_PCT = 0.05
export const MARKET_SLIPPAGE_ABS = 0.03

function tickDecimals(tick: number): number {
  return Math.max(0, Math.round(-Math.log10(tick)))
}

/** Snap to the tick grid (ceil for a buy ceiling, floor for a sell floor). */
function snapToTick(price: number, tick: number, dir: 'up' | 'down'): number {
  const units = dir === 'up' ? Math.ceil(price / tick) : Math.floor(price / tick)
  return Number((units * tick).toFixed(tickDecimals(tick)))
}

function slippagePad(price: number, multiplier = 1): number {
  return multiplier * Math.max(MARKET_SLIPPAGE_ABS, price * MARKET_SLIPPAGE_PCT)
}

/** BUY limit ceiling: best ask + pad, rounded UP to the tick, clamped to [tick, 1 - tick]. */
export function bufferMarketBuyPrice(
  bookPrice: number,
  tickSize: TickSize = '0.01',
  padMultiplier = 1,
): number {
  const tick = Number(tickSize)
  const ceil = snapToTick(bookPrice + slippagePad(bookPrice, padMultiplier), tick, 'up')
  return Math.min(1 - tick, Math.max(tick, ceil))
}

/** SELL limit floor: best bid - pad, rounded DOWN to the tick, clamped to [tick, 1 - tick].
 * A FAK still fills at the top bids; the lower limit only lets it sweep deeper if needed. */
export function bufferMarketSellPrice(bookPrice: number, tickSize: TickSize = '0.01'): number {
  const tick = Number(tickSize)
  const floor = snapToTick(bookPrice - slippagePad(bookPrice), tick, 'down')
  return Math.max(tick, Math.min(1 - tick, floor))
}

function clientBuyHint(price: number | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0 || price >= 1) return null
  return price
}

/** Raw FAK book-walk price — buffered separately once tick size is known. FAK (not FOK)
 * so thin books return the top ask instead of throwing "no match". */
async function rawMarketBuyPrice(client: ClobClient, tokenId: string, amount: number): Promise<number> {
  return client.calculateMarketPrice(tokenId, Side.BUY, amount, OrderType.FAK)
}

const DEPOSIT_WALLET_DOCS = 'https://docs.polymarket.com/trading/deposit-wallets'

const marketParamsCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>()

async function marketParams(
  client: ClobClient,
  tokenId: string,
  hint?: { tickSize: TickSize; negRisk: boolean } | null,
) {
  // Server cache is authoritative (populated by warmOrderPath / prior orders).
  const cached = marketParamsCache.get(tokenId)
  if (cached) return cached
  // On a cold instance, trust the client's gamma-sourced metadata to skip two CLOB
  // round trips (getTickSize + getNegRisk). Not cached — the next warm/order fetches
  // the authoritative values, so a stale client value can't poison later orders.
  if (hint) return hint
  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ])
  const params = { tickSize: tickSize as TickSize, negRisk }
  marketParamsCache.set(tokenId, params)
  return params
}

export async function fetchUsdcBalance(): Promise<number> {
  const client = getClobClient()
  if (!client) {
    throw new Error('Polymarket credentials are not configured on the server')
  }
  const balanceRes = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL })
  return Number(balanceRes.balance) / 1e6
}

export async function placeMarketOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const config = requirePrivateKey('place orders')
  assertWalletConfig(config)

  const amount = params.amount
  if (amount == null || !Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number')
  }
  if (params.side === 'BUY' && amount < MIN_BUY_USD) {
    throw new Error(`Minimum buy size is $${MIN_BUY_USD.toFixed(2)}`)
  }

  const hint = params.side === 'BUY' ? clientBuyHint(params.price) : null
  const metaHint = clientMarketParamsHint(params)
  const clob = createClobClient(config)

  const [{ client, tickSize, negRisk }, bookPrice] = await Promise.all([
    prepareOrder(config, params.tokenId, metaHint),
    hint == null && params.side === 'BUY'
      ? rawMarketBuyPrice(clob, params.tokenId, amount)
      : Promise.resolve(null),
  ])

  // FAK (Fill-And-Kill) for both sides: take whatever is resting now and cancel the
  // remainder. FOK rejects the whole order when the book can't absorb the full size
  // in one shot — common on thin crypto up/down books ("no match") and costs a slow
  // retry. FAK fills instantly with whatever liquidity exists.
  const marketOrderType = OrderType.FAK

  const orderArgs: Parameters<ClobClient['createAndPostMarketOrder']>[0] = {
    tokenID: params.tokenId,
    side: params.side === 'SELL' ? Side.SELL : Side.BUY,
    amount,
    orderType: marketOrderType,
  }

  if (params.side === 'BUY') {
    // Live WS ask from the browser skips a CLOB book-walk on the hot path; either way
    // the limit is buffered above the touch so the FAK crosses on the first shot.
    orderArgs.price = bufferMarketBuyPrice(hint ?? bookPrice!, tickSize)
  } else if (params.price != null && Number.isFinite(params.price) && params.price > 0 && params.price < 1) {
    // Live WS bid from the browser, buffered DOWN to the tick. Passing a price makes
    // clob-client-v2 skip its own book-walk round trip (client.js:448); the FAK still
    // fills at the top bids, so this only sets how deep it may sweep.
    orderArgs.price = bufferMarketSellPrice(params.price, tickSize)
  }

  let response = await client.createAndPostMarketOrder(
    orderArgs,
    { tickSize, negRisk },
    marketOrderType,
  )

  let result = unwrapOrderResult(response, params.side)
  if (params.side === 'BUY' && (result.status ?? '').toLowerCase() === 'unmatched') {
    // Book moved past the first ceiling — retry once with 2× slippage pad. No book-walk
    // (that adds a round trip and throws "no match" on empty asks).
    const base = hint ?? bookPrice
    if (base != null) {
      orderArgs.price = bufferMarketBuyPrice(base, tickSize, 2)
      response = await client.createAndPostMarketOrder(orderArgs, { tickSize, negRisk }, marketOrderType)
      result = unwrapOrderResult(response, params.side)
    }
  } else if (
    params.side === 'SELL' &&
    (result.status ?? '').toLowerCase() === 'unmatched' &&
    orderArgs.price != null
  ) {
    // The client mark can be a mid/last-trade or polled fallback sitting above every
    // resting bid, pricing the buffered floor out of the book. Retry once WITHOUT a
    // price so clob-client-v2 walks the live book and floors off real bids.
    delete orderArgs.price
    try {
      response = await client.createAndPostMarketOrder(orderArgs, { tickSize, negRisk }, marketOrderType)
      result = unwrapOrderResult(response, params.side)
    } catch {
      // Book-walk threw (no bids at all) — keep the original unmatched result.
    }
  }

  return result
}

export async function placeLimitOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const config = requirePrivateKey('place orders')
  assertWalletConfig(config)

  const price = params.price
  const size = params.size
  if (price == null || !Number.isFinite(price) || price <= 0 || price >= 1) {
    throw new Error('price must be between 0 and 1 (exclusive)')
  }
  if (size == null || !Number.isFinite(size) || size <= 0) {
    throw new Error('size must be a positive number of shares')
  }
  if (params.side === 'BUY' && price * size < MIN_BUY_USD) {
    throw new Error(`Minimum buy size is $${MIN_BUY_USD.toFixed(2)} (currently $${(price * size).toFixed(2)})`)
  }

  const { client, tickSize, negRisk } = await prepareOrder(config, params.tokenId, clientMarketParamsHint(params))

  const response = await client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price,
      size,
      side: params.side === 'SELL' ? Side.SELL : Side.BUY,
    },
    { tickSize, negRisk },
    OrderType.GTC,
  )

  return unwrapOrderResult(response, params.side)
}

function enrichOrderErrorMessage(message: string): string {
  const lower = message.toLowerCase()
  if (lower.includes('no match')) {
    return 'No resting liquidity on the book — wait for live quotes, then try again'
  }
  if (lower.includes('maker address not allowed') || lower.includes('deposit wallet')) {
    return (
      'Your account must use the deposit wallet flow. Set POLY_SIGNATURE_TYPE=3, ' +
      'POLY_FUNDER_ADDRESS to your deposit wallet (from polymarket.com/profile → proxyAddress), ' +
      'keep POLY_ADDRESS/POLY_PRIVATE_KEY as your signer EOA, and place one small trade on ' +
      `polymarket.com first to deploy the wallet. Docs: ${DEPOSIT_WALLET_DOCS}`
    )
  }
  if (lower.includes('signer address has to be the address of the api key')) {
    return (
      'Deposit wallet may not be deployed yet — place one small trade on polymarket.com, ' +
      'then confirm POLY_FUNDER_ADDRESS matches proxyAddress on your profile page.'
    )
  }
  return message
}

export function formatOrderError(error: unknown): { message: string; status: number } {
  if (error instanceof ApiError) {
    return { message: enrichOrderErrorMessage(error.message), status: error.status || 400 }
  }
  if (error instanceof Error) {
    return { message: enrichOrderErrorMessage(error.message), status: 500 }
  }
  return { message: 'Order failed', status: 500 }
}

export interface OpenOrderView {
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

export async function fetchOpenOrders(): Promise<OpenOrderView[]> {
  const client = getClobClient()
  if (!client) {
    throw new Error('Polymarket credentials are not configured on the server')
  }

  const orders = await client.getOpenOrders(undefined, true)
  if (!Array.isArray(orders)) return []

  return orders.map((order) => {
    const originalSize = Number(order.original_size)
    const sizeMatched = Number(order.size_matched)
    const remaining = Math.max(0, originalSize - sizeMatched)
    return {
      id: order.id,
      side: order.side,
      outcome: order.outcome,
      price: Number(order.price),
      originalSize,
      sizeMatched,
      sizeRemaining: remaining,
      status: order.status,
      assetId: order.asset_id,
      createdAt: order.created_at,
    }
  })
}

export async function cancelOpenOrder(orderId: string): Promise<void> {
  const config = requirePrivateKey('cancel orders')
  const client = createClobClient(config)
  await client.cancelOrder({ orderID: orderId })
}

export async function fetchAccountSnapshot(): Promise<AccountSnapshot> {
  const config = getPolyConfig()
  if (!config) {
    throw new Error('Polymarket credentials are not configured on the server')
  }

  const client = createClobClient(config)
  const [balanceRes, ordersRes] = await Promise.all([
    client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }),
    client.getOpenOrders(undefined, true),
  ])

  const walletSetupIssue = getWalletSetupIssue(config)

  return {
    address: config.address,
    funderAddress: config.funderAddress,
    signatureType: config.signatureType,
    usdcBalance: Number(balanceRes.balance) / 1e6,
    openOrderCount: Array.isArray(ordersRes) ? ordersRes.length : 0,
    canTrade: Boolean(config.privateKey) && !walletSetupIssue,
    walletSetupIssue,
  }
}
