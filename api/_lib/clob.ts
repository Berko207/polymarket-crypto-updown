import {
  ApiError,
  AssetType,
  Chain,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
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

export function createClobClient(config: PolyServerConfig): ClobClient {
  const creds = toApiCreds(config)
  const signer = config.privateKey ? walletFromPrivateKey(config.privateKey) : undefined

  return new ClobClient({
    host: CLOB_HOST,
    chain: Chain.POLYGON,
    signer,
    creds,
    signatureType: config.signatureType,
    funderAddress: config.funderAddress,
    useServerTime: true,
    throwOnError: true,
  })
}

export function getClobClient(): ClobClient | null {
  const config = getPolyConfig()
  if (!config) return null
  return createClobClient(config)
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
  price: number
  size: number
}

export interface PlaceOrderResult {
  success: boolean
  orderId?: string
  status?: string
}

const DEPOSIT_WALLET_DOCS = 'https://docs.polymarket.com/trading/deposit-wallets'

export async function placeLimitOrder(params: PlaceOrderParams): Promise<PlaceOrderResult> {
  const config = getPolyConfig()
  if (!config?.privateKey) {
    throw new Error('POLY_PRIVATE_KEY is required to place orders')
  }

  assertWalletConfig(config)

  const client = createClobClient(config)

  if (config.signatureType === SignatureTypeV2.POLY_1271) {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL })
  }

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(params.tokenId),
    client.getNegRisk(params.tokenId),
  ])

  const response = await client.createAndPostOrder(
    {
      tokenID: params.tokenId,
      price: params.price,
      size: params.size,
      side: params.side === 'SELL' ? Side.SELL : Side.BUY,
    },
    { tickSize, negRisk },
    OrderType.GTC,
  )

  const record = response as Record<string, unknown> | null
  return {
    success: true,
    orderId: typeof record?.orderID === 'string' ? record.orderID : undefined,
    status: typeof record?.status === 'string' ? record.status : undefined,
  }
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
  const config = getPolyConfig()
  if (!config?.privateKey) {
    throw new Error('POLY_PRIVATE_KEY is required to cancel orders')
  }

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
