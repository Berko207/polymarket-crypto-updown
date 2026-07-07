/**
 * Live USDC recovery — redeem winning outcome tokens after Polymarket marks them
 * redeemable via the gasless relayer (uses POLY_PRIVATE_KEY + proxy/safe wallet).
 */
import { SignatureTypeV2 } from '@polymarket/clob-client-v2'
import { encodeFunctionData, prepareEncodeFunctionData, zeroHash, type Hex } from 'viem'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { polygon } from 'viem/chains'
import type { Transaction } from '@polymarket/builder-relayer-client'
import { getPolyConfig } from '../../api/_lib/env'
import { fetchEventConditionId } from './gamma'
import { DATA_API } from './polyPositions'

const DEFAULT_POLYGON_RPC = 'https://polygon-bor.publicnode.com'
const CTF = '0x4d97dcd97ec945f40cf65f87097ace5ea0476045'
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'

const ctfRedeemAbi = [
  {
    constant: false,
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    name: 'redeemPositions',
    outputs: [],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const nrAdapterRedeemAbi = [
  {
    inputs: [
      { internalType: 'bytes32', name: '_conditionId', type: 'bytes32' },
      { internalType: 'uint256[]', name: '_amounts', type: 'uint256[]' },
    ],
    name: 'redeemPositions',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

const ctfEncode = prepareEncodeFunctionData({
  abi: ctfRedeemAbi,
  functionName: 'redeemPositions',
})

const nrEncode = prepareEncodeFunctionData({
  abi: nrAdapterRedeemAbi,
  functionName: 'redeemPositions',
})

export interface RedeemablePosition {
  tokenId: string
  size: number
  redeemable: boolean
  eventSlug: string
}

let relayClient: import('@polymarket/builder-relayer-client').RelayClient | null = null
let relayInitFailed = false

async function getRelayClient(): Promise<import('@polymarket/builder-relayer-client').RelayClient | null> {
  if (relayInitFailed) return null
  if (relayClient) return relayClient
  const poly = getPolyConfig()
  if (!poly?.privateKey) {
    relayInitFailed = true
    return null
  }
  try {
    const { RelayClient, RelayerTxType } = await import('@polymarket/builder-relayer-client')
    const account = privateKeyToAccount(poly.privateKey as Hex)
    const wallet = createWalletClient({
      account,
      chain: polygon,
      transport: http(process.env.POLYGON_RPC_URL?.trim() || DEFAULT_POLYGON_RPC),
    })
    const relayTxType =
      poly.signatureType === SignatureTypeV2.POLY_PROXY ? RelayerTxType.PROXY : RelayerTxType.SAFE
    relayClient = new RelayClient(
      'https://relayer-v2.polymarket.com/',
      137,
      wallet as never,
      undefined,
      relayTxType,
    )
    return relayClient
  } catch {
    relayInitFailed = true
    return null
  }
}

function ctfRedeemTx(conditionId: string): Transaction {
  return {
    to: CTF,
    data: encodeFunctionData({
      ...ctfEncode,
      args: [USDC, zeroHash, conditionId as Hex, [1n, 2n]],
    }),
    value: '0',
  }
}

function negRiskRedeemTx(conditionId: string, yesShares: number, noShares: number): Transaction {
  const toUnits = (n: number): bigint => BigInt(Math.round(n * 1e6))
  return {
    to: NEG_RISK_ADAPTER,
    data: encodeFunctionData({
      ...nrEncode,
      args: [conditionId as Hex, [toUnits(yesShares), toUnits(noShares)]],
    }),
    value: '0',
  }
}

/** Data-API scan for redeemable token balances on the funder wallet. */
export async function fetchRedeemableByToken(user: string): Promise<Map<string, RedeemablePosition>> {
  const out = new Map<string, RedeemablePosition>()
  const limit = 500
  for (let page = 0; page < 8; page++) {
    const url = `${DATA_API}?user=${encodeURIComponent(user)}&sizeThreshold=0.01&limit=${limit}&offset=${page * limit}`
    const res = await fetch(url)
    if (!res.ok) break
    const rows = (await res.json()) as {
      asset?: string
      size?: number
      redeemable?: boolean
      eventSlug?: string
    }[]
    if (!Array.isArray(rows) || rows.length === 0) break
    for (const row of rows) {
      const tokenId = typeof row.asset === 'string' ? row.asset : null
      const size = Number(row.size)
      if (!tokenId || !Number.isFinite(size) || size <= 0) continue
      out.set(tokenId, {
        tokenId,
        size,
        redeemable: row.redeemable === true,
        eventSlug: typeof row.eventSlug === 'string' ? row.eventSlug : '',
      })
    }
    if (rows.length < limit) break
  }
  return out
}

export interface RedeemResult {
  ok: boolean
  error?: string
}

/** Submit a gasless redeem for one winning position. */
export async function redeemWinningPosition(opts: {
  eventSlug: string
  side: 'up' | 'down'
  size: number
  negRisk: boolean
}): Promise<RedeemResult> {
  const client = await getRelayClient()
  if (!client) return { ok: false, error: 'relay client unavailable (check POLY_PRIVATE_KEY)' }

  const meta = await fetchEventConditionId(opts.eventSlug)
  if (!meta?.conditionId) return { ok: false, error: 'conditionId not found from gamma' }

  const negRisk = opts.negRisk || meta.negRisk
  const tx = negRisk
    ? negRiskRedeemTx(
        meta.conditionId,
        opts.side === 'up' ? opts.size : 0,
        opts.side === 'down' ? opts.size : 0,
      )
    : ctfRedeemTx(meta.conditionId)

  try {
    const resp = await client.execute([tx], 'bot redeem certainty')
    const result = await resp.wait()
    if (!result) return { ok: false, error: 'redeem tx failed' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function redeemEnvHint(): string | null {
  if (!getPolyConfig()?.privateKey) {
    return 'POLY_PRIVATE_KEY required for live auto-redeem after windows resolve'
  }
  return null
}
