const GAMMA_PROFILE = 'https://gamma-api.polymarket.com/public-profile'

export interface ResolvedTradingWallet {
  proxyWallet: string | null
}

export async function resolveTradingWallet(signerAddress: string): Promise<ResolvedTradingWallet> {
  try {
    const url = `${GAMMA_PROFILE}?address=${encodeURIComponent(signerAddress)}`
    const res = await fetch(url)
    if (!res.ok) return { proxyWallet: null }

    const data = (await res.json()) as { proxyWallet?: unknown }
    const proxyWallet = typeof data.proxyWallet === 'string' ? data.proxyWallet : null
    return { proxyWallet }
  } catch {
    return { proxyWallet: null }
  }
}
