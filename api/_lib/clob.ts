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
async function prepareOrder(config: PolyServerConfig, tokenId: string) {
  const client = createClobClient(config)
  const [, params] = await Promise.all([
    usesDepositWalletAllowance(config) ? ensureCollateralAllowance(client) : Promise.resolve(),
    marketParams(client, tokenId),
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

function unwrapOrderResult(response: unknown): PlaceOrderResult {
  const record = response as Record<string, unknown> | null
  return {
    success: true,
    orderId: typeof record?.orderID === 'string' ? record.orderID : undefined,
    status: typeof record?.status === 'string' ? record.status : undefined,
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
}

export interface PlaceOrderResult {
  success: boolean
  orderId?: string
  status?: string
}

export const MIN_BUY_USD = 1

/** Extra headroom on top of a fresh FOK book walk — books move between quote and submit. */
export const MARKET_BUY_SLIPPAGE = 0.05

export function bufferMarketBuyPrice(bookPrice: number): number {
  const bumped = bookPrice * (1 + MARKET_BUY_SLIPPAGE)
  return Math.min(0.99, Math.round(bumped * 100) / 100)
}

function clientBuyHint(price: number | undefined): number | null {
  if (price == null || !Number.isFinite(price) || price <= 0 || price >= 1) return null
  return price
}

async function resolveMarketBuyPrice(client: ClobClient, tokenId: string, amount: number): Promise<number> {
  const fromBook = await client.calculateMarketPrice(tokenId, Side.BUY, amount, OrderType.FOK)
  return bufferMarketBuyPrice(fromBook)
}

const DEPOSIT_WALLET_DOCS = 'https://docs.polymarket.com/trading/deposit-wallets'

const marketParamsCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>()

async function marketParams(client: ClobClient, tokenId: string) {
  const cached = marketParamsCache.get(tokenId)
  if (cached) return cached
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
  const clob = createClobClient(config)

  const [{ client, tickSize, negRisk }, bookPrice] = await Promise.all([
    prepareOrder(config, params.tokenId),
    hint == null && params.side === 'BUY'
      ? resolveMarketBuyPrice(clob, params.tokenId, amount)
      : Promise.resolve(null),
  ])

  const orderArgs: Parameters<ClobClient['createAndPostMarketOrder']>[0] = {
    tokenID: params.tokenId,
    side: params.side === 'SELL' ? Side.SELL : Side.BUY,
    amount,
    orderType: OrderType.FOK,
  }

  if (params.side === 'BUY') {
    // Live WS ask from the browser skips a CLOB book-walk on the hot path.
    orderArgs.price = hint != null ? bufferMarketBuyPrice(hint) : bookPrice!
  } else if (params.price != null) {
    orderArgs.price = params.price
  }

  let response = await client.createAndPostMarketOrder(
    orderArgs,
    { tickSize, negRisk },
    OrderType.FOK,
  )

  let result = unwrapOrderResult(response)
  if (params.side === 'BUY' && hint != null && (result.status ?? '').toLowerCase() === 'unmatched') {
    orderArgs.price = await resolveMarketBuyPrice(client, params.tokenId, amount)
    response = await client.createAndPostMarketOrder(orderArgs, { tickSize, negRisk }, OrderType.FOK)
    result = unwrapOrderResult(response)
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

  const { client, tickSize, negRisk } = await prepareOrder(config, params.tokenId)

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

  return unwrapOrderResult(response)
}

function enrichOrderErrorMessage(message: string): string {
  const lower = message.toLowerCase()
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
