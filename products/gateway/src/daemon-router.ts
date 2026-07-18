import type * as http from 'node:http'
import type { z } from 'zod'

export const MAX_JSON_BODY_BYTES = 1024 * 1024

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export interface RouteContext {
  req: http.IncomingMessage
  url: URL
  client: any
  channels: Map<string, any>
}

export interface RouteResponse {
  status?: number
  body: unknown
  contentType?: string
  afterSend?: () => void
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResponse | undefined> | RouteResponse | undefined

export type ApiRouteMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

/**
 * Runtime-adjacent metadata consumed by the API reference generator. Body and
 * query schemas are the same Zod instances used by route handlers, which keeps
 * the generated contract tied to request validation instead of a second hand-
 * maintained schema.
 */
export interface ApiRouteContract {
  method: ApiRouteMethod
  path: string
  bodySchema?: z.ZodTypeAny
  requestBody?: false
  querySchemas?: Record<string, z.ZodTypeAny>
  responses?: readonly number[]
}

export function defineApiRouteContracts<const Contracts extends readonly ApiRouteContract[]>(contracts: Contracts): Contracts {
  return contracts
}

export function json(body: unknown, status = 200, afterSend?: () => void): RouteResponse {
  return { status, body, afterSend }
}

export async function dispatchRoute(routes: RouteHandler[], ctx: RouteContext): Promise<RouteResponse | undefined> {
  assertValidUrlPath(ctx.url.pathname)
  for (const route of routes) {
    const response = await route(ctx)
    if (response) return response
  }
  return undefined
}

export function sendRouteResponse(res: http.ServerResponse, response: RouteResponse): void {
  res.setHeader('Content-Type', response.contentType || 'application/json')
  res.writeHead(response.status || 200)
  res.end(typeof response.body === 'string' && response.contentType !== 'application/json' ? response.body : JSON.stringify(response.body))
  response.afterSend?.()
}

export function pathMatch(pathname: string, pattern: RegExp): [string, ...string[]] | undefined {
  const match = pathname.match(pattern)
  if (!match) return undefined
  let groups: string[]
  try {
    groups = match.slice(1).map(value => decodeURIComponent(value))
  } catch {
    throw new HttpError(400, 'malformed URL path encoding')
  }
  return groups as [string, ...string[]]
}

export function assertValidUrlPath(pathname: string): void {
  try {
    // Validation only. Keep the original encoded pathname for route matching so
    // encoded slashes cannot change segment boundaries.
    decodeURI(pathname)
  } catch {
    throw new HttpError(400, 'malformed URL path encoding')
  }
}

export type JsonObjectBody = Record<string, unknown>

export function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return readBody(req).then(parseJsonBody)
}

export async function readJsonBodyAs<Schema extends z.ZodTypeAny>(
  req: http.IncomingMessage,
  schema: Schema,
  label = 'body',
): Promise<z.infer<Schema>> {
  return validateJsonBody(schema, await readJsonBody(req), label)
}

export function validateJsonBody<Schema extends z.ZodTypeAny>(
  schema: Schema,
  body: unknown,
  label = 'body',
): z.infer<Schema> {
  const result = schema.safeParse(body)
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : label
    throw new HttpError(400, `${path}: ${issue?.message || 'invalid request body'}`)
  }
  return result.data
}

export function parseJsonBody(raw: string): JsonObjectBody {
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    throw new HttpError(400, 'invalid JSON body')
  }
  if (!isJsonObjectBody(parsed)) {
    throw new HttpError(400, 'invalid JSON body: expected object')
  }
  return parsed
}

function isJsonObjectBody(value: unknown): value is JsonObjectBody {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

export function readBody(req: http.IncomingMessage, maxBytes = MAX_JSON_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    let bytes = 0
    let done = false
    req.on('data', chunk => {
      if (done) return
      bytes += chunk.length
      if (bytes > maxBytes) {
        done = true
        reject(new HttpError(413, `request body exceeds ${maxBytes} bytes`))
        req.removeAllListeners('data')
        req.resume()
        return
      }
      data += chunk
    })
    req.on('end', () => { if (!done) resolve(data) })
    req.on('error', err => { if (!done) reject(err) })
  })
}
