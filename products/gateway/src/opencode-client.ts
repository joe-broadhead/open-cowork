/**
 * Construct the process OpenCode SDK client with peer allowlist validation
 * and optional trusted-peer Basic auth (never URL-embedded credentials).
 */
import * as fs from 'node:fs'
// Classic client entry at monorepo pin 1.18.1 (audit 2026-07-18 / JOE-941).
// Session I/O is collapsed onto opencode-session-runtime.ts (single flip point).
// Do not construct @opencode-ai/sdk/v2 here until real-process V2 probes pass
// and docs/opencode-durable-gateway-classic-burndown.md is updated in the same change.
import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'
import { getConfig, type GatewayConfig } from './config.js'
import { openCodeEndpointUrl, safeOpenCodeBaseUrlString } from './opencode-url-policy.js'
import { createLogger } from './logger.js'

const log = createLogger({ component: 'opencode-client' })

export interface GatewayOpenCodeClientOptions {
  opencodeUrl?: string
  config?: GatewayConfig
}

export function createGatewayOpenCodeClient(options: GatewayOpenCodeClientOptions = {}): {
  client: OpencodeClient
  baseUrl: string
  peerName?: string
  authMode: 'none' | 'basic'
} {
  const config = options.config || getConfig()
  const baseUrl = safeOpenCodeBaseUrlString(options.opencodeUrl || config.opencodeUrl)
  const peer = matchOpenCodePeer(baseUrl, config)
  const auth = resolvePeerBasicAuth(peer)
  const authHeader = auth.headers['Authorization']
  const client = createOpencodeClient({
    baseUrl,
    headers: authHeader ? { Authorization: authHeader } : undefined,
    fetch: authHeader
      ? (input: any, init?: RequestInit) => {
          const nextHeaders = new Headers(init?.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined))
          if (!nextHeaders.has('Authorization')) nextHeaders.set('Authorization', authHeader)
          return globalThis.fetch(input, { ...init, headers: nextHeaders })
        }
      : undefined,
  } as any)

  if (peer?.name) {
    log.info('OpenCode peer client configured', {
      peer: peer.name,
      baseUrl,
      authMode: auth.mode,
    })
  }

  return { client, baseUrl, peerName: peer?.name, authMode: auth.mode }
}

export interface OpenCodeFetchOptions {
  timeoutMs?: number
}

export async function openCodeFetch(opencodeUrl: string, path: string, init: RequestInit = {}, options: OpenCodeFetchOptions = {}): Promise<Response> {
  const config = getConfig()
  const baseUrl = safeOpenCodeBaseUrlString(opencodeUrl || config.opencodeUrl)
  const peer = matchOpenCodePeer(baseUrl, config)
  const auth = resolvePeerBasicAuth(peer)
  const headers = new Headers(init.headers)
  const authHeader = auth.headers['Authorization']
  if (authHeader && !headers.has('Authorization')) headers.set('Authorization', authHeader)
  const timeoutMs = options.timeoutMs
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(openCodeEndpointUrl(baseUrl, path), { ...init, headers })
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  timeout.unref?.()
  const upstreamSignal = init.signal
  const abortFromUpstream = () => controller.abort(upstreamSignal?.reason)
  if (upstreamSignal?.aborted) abortFromUpstream()
  else upstreamSignal?.addEventListener('abort', abortFromUpstream, { once: true })
  try {
    return await fetch(openCodeEndpointUrl(baseUrl, path), {
      ...init,
      headers,
      signal: controller.signal,
    })
  } finally {
    upstreamSignal?.removeEventListener('abort', abortFromUpstream)
    clearTimeout(timeout)
  }
}

function matchOpenCodePeer(baseUrl: string, config: GatewayConfig): { name: string; peer: NonNullable<GatewayConfig['opencodePeers']>[string] } | undefined {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return undefined
  }
  for (const [name, peer] of Object.entries(config.opencodePeers || {})) {
    const allowed = new Set((peer.allowHostnames || []).map(h => h.toLowerCase()))
    try {
      allowed.add(new URL(peer.baseUrl).hostname.toLowerCase())
    } catch {
      // ignore
    }
    if (allowed.has(host)) return { name, peer }
  }
  return undefined
}

function resolvePeerBasicAuth(match: { name: string; peer: NonNullable<GatewayConfig['opencodePeers']>[string] } | undefined): {
  mode: 'none' | 'basic'
  headers: Record<string, string>
} {
  if (!match?.peer.basicAuth) return { mode: 'none', headers: {} }
  const usernameEnv = match.peer.basicAuth.usernameEnv || 'OPENCODE_SERVER_USERNAME'
  const username = process.env[usernameEnv] || 'opencode'
  let password: string | undefined
  if (match.peer.basicAuth.passwordEnv) {
    password = process.env[match.peer.basicAuth.passwordEnv]
  }
  if (!password && match.peer.basicAuth.passwordFile) {
    try {
      password = fs.readFileSync(match.peer.basicAuth.passwordFile, 'utf8').trim()
    } catch (err: any) {
      throw new Error(`OpenCode peer "${match.name}" passwordFile unreadable: ${err?.message || err}`)
    }
  }
  if (!password) password = process.env['OPENCODE_SERVER_PASSWORD']
  if (!password) {
    throw new Error(
      `OpenCode peer "${match.name}" requires basicAuth credentials via ${match.peer.basicAuth.passwordEnv || 'OPENCODE_SERVER_PASSWORD'} or passwordFile`,
    )
  }
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64')
  return { mode: 'basic', headers: { Authorization: `Basic ${token}` } }
}
