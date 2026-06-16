import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { resolveHttpClientSource } from '@open-cowork/shared'
import { firstHeader } from './http-request-parsers.ts'
import { WebhookHttpError, type WorkflowWebhookAuth } from '../workflow/workflow-webhook-server.ts'

// Pure request-context helpers for the cloud HTTP server, extracted from
// http-server.ts: resolve the client source (honouring the trusted-proxy
// policy), the validated CORS origin, a flattened header record, the
// rate-limit/auth-failure scope keys, and the signature webhook auth envelope.
// No server state.

export function workflowScopeKey(workflowId: string) {
  return createHash('sha256').update(workflowId || 'unknown-workflow').digest('hex').slice(0, 16)
}

export function requestSource(
  req: IncomingMessage,
  trustProxyHeaders = false,
  trustedProxyCidrs: readonly string[] | null | undefined = null,
) {
  return resolveHttpClientSource({
    socketAddress: req.socket.remoteAddress,
    headers: req.headers,
    policy: { trustProxyHeaders, trustedProxyCidrs },
  })
}

export function requestCorsOrigin(req: IncomingMessage, configuredOrigin: string | null | undefined) {
  const configured = configuredOrigin?.trim()
  if (!configured) return null
  const origin = firstHeader(req.headers.origin).trim()
  return origin === configured ? configured : null
}

export function requestHeaderRecord(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name.toLowerCase()] = Array.isArray(value) ? value[0] : value
  }
  return headers
}

export function authFailureScopes(
  req: IncomingMessage,
  trustProxyHeaders = false,
  trustedProxyCidrs: readonly string[] | null | undefined = null,
) {
  const source = requestSource(req, trustProxyHeaders, trustedProxyCidrs)
  const authorization = firstHeader(req.headers.authorization).trim()
  const scopes = [`ip:${source}`]
  if (!authorization) return scopes
  const tokenHash = createHash('sha256').update(authorization).digest('hex').slice(0, 16)
  scopes.push(`auth:${tokenHash}`)
  return scopes
}

export function webhookAuthScope(source: string, workflowId: string) {
  return `${source}:${workflowScopeKey(workflowId)}`
}

export function extractSignatureWebhookAuth(req: IncomingMessage, rawBody: string): WorkflowWebhookAuth {
  const timestamp = firstHeader(req.headers['x-open-cowork-timestamp']).trim()
  const signature = firstHeader(req.headers['x-open-cowork-signature']).trim()
  if (!timestamp || !signature) {
    throw new WebhookHttpError(401, 'Workflow webhook signature authorization is required.')
  }
  return { kind: 'signature', timestamp, signature, rawBody }
}
