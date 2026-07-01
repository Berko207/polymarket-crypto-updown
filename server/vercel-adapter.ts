import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VercelRequest, VercelResponse } from '@vercel/node'

type ApiHandler = (req: VercelRequest, res: VercelResponse) => void | Promise<void>

function parseQuery(url: URL): VercelRequest['query'] {
  const query: Record<string, string | string[]> = {}
  for (const [key, value] of url.searchParams) {
    const prev = query[key]
    if (prev === undefined) query[key] = value
    else if (Array.isArray(prev)) prev.push(value)
    else query[key] = [prev, value]
  }
  return query
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return undefined
  const ct = req.headers['content-type'] ?? ''
  if (ct.includes('application/json')) {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return raw
    }
  }
  return raw
}

export function wrapResponse(res: ServerResponse): VercelResponse {
  let statusCode = 200
  const self = {
    status(code: number) {
      statusCode = code
      return self
    },
    setHeader(name: string, value: string | number | readonly string[]) {
      res.setHeader(name, value)
      return self
    },
    json(obj: unknown) {
      if (res.writableEnded) return self
      res.statusCode = statusCode
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(obj))
      return self
    },
    send(body: string) {
      if (res.writableEnded) return self
      res.statusCode = statusCode
      res.end(body)
      return self
    },
    end(chunk?: string) {
      if (res.writableEnded) return self
      res.statusCode = statusCode
      res.end(chunk)
      return self
    },
  }
  return self as VercelResponse
}

export async function invokeHandler(
  handler: ApiHandler,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
  const vercelReq = {
    method: req.method,
    url: url.pathname + url.search,
    headers: req.headers,
    query: parseQuery(url),
    body,
    cookies: {},
  } as VercelRequest

  await handler(vercelReq, wrapResponse(res))
}
