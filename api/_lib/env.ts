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
