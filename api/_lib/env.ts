import { SignatureType } from '@polymarket/clob-client'

export interface PolyServerConfig {
  address: string
  apiKey: string
  apiSecret: string
  apiPassphrase: string
  signatureType: SignatureType
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

  const signatureType = Number(read('POLY_SIGNATURE_TYPE') ?? SignatureType.EOA)
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
