import type { VercelRequest, VercelResponse } from '@vercel/node'
import { getApiSecret } from './_lib/auth.js'

export default function handler(_req: VercelRequest, res: VercelResponse) {
  return res.status(200).json({
    authRequired: Boolean(getApiSecret()),
  })
}
