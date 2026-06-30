import './loadEnv.js'
import { SignatureTypeV2 } from '@polymarket/clob-client-v2'

export interface PolyServerConfig {
  address: string
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  signatureType: SignatureTypeV2
  funderAddress: string
  privateKey?: string
}

function read(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value || undefined
}

export function getPolyConfig(): PolyServerConfig | null {
  const address = read('POLY_ADDRESS')
  const apiKey = read('POLY_API_KEY')
  const apiSecret = read('POLY_API_SECRET')
  const apiPassphrase = read('POLY_API_PASSPHRASE')

  if (!address || !apiKey || !apiSecret || !apiPassphrase) return null

  const signatureType = Number(read('POLY_SIGNATURE_TYPE') ?? SignatureTypeV2.EOA) as SignatureTypeV2
  const funderAddress = read('POLY_FUNDER_ADDRESS') ?? address
  const privateKey = read('POLY_PRIVATE_KEY')

  return {
    address,
    apiKey,
    apiSecret,
    apiPassphrase,
    signatureType,
    funderAddress,
    privateKey,
  }
}

export function isPolyConfigured(): boolean {
  return getPolyConfig() !== null
}

export function canPlaceOrders(): boolean {
  return Boolean(getPolyConfig()?.privateKey)
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** Returns a setup hint when env vars don't match Polymarket's wallet model. */
export function getWalletSetupIssue(config: PolyServerConfig): string | null {
  const funderMatchesSigner = sameAddress(config.funderAddress, config.address)

  if (funderMatchesSigner) {
    return (
      'POLY_FUNDER_ADDRESS must be your Polymarket trading wallet (deposit/proxy), not the same as POLY_ADDRESS. ' +
      'Check the Account panel for the suggested address.'
    )
  }

  if (config.signatureType === SignatureTypeV2.EOA) {
    return (
      'New Polymarket accounts require the deposit wallet flow: POLY_SIGNATURE_TYPE=3 and ' +
      'POLY_FUNDER_ADDRESS set to your deposit wallet address.'
    )
  }

  return null
}

export function assertWalletConfig(config: PolyServerConfig): void {
  const issue = getWalletSetupIssue(config)
  if (issue) throw new Error(issue)
}
