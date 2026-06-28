// Postgres LISTEN/NOTIFY realtime accelerator for cloud SSE delivery (audit F1b).
//
// OPT-IN, default OFF (OPEN_COWORK_CLOUD_SSE_PG_NOTIFY). With the flag OFF nothing in
// this module runs: no LISTEN connection is opened and no NOTIFY is issued, so SSE
// delivery is byte-for-byte the existing per-stream Postgres poll loop.
//
// With the flag ON the accelerator only triggers an EARLIER read of the SAME
// `*ForStream` query the poll loop already runs (via the replay hub's wake()). Polling
// stays the guaranteed backstop — NOTIFY never becomes the sole delivery path and never
// assumes a notification was or wasn't delivered. A missed NOTIFY is caught by the next
// poll; a duplicate NOTIFY is harmless because the read is sequence-based / idempotent.
//
// The cross-connection NOTIFY -> wake behaviour cannot be validated locally (in-memory /
// PGlite do not model cross-connection LISTEN/NOTIFY); the real-Postgres path is covered
// in CI. Everything here is therefore designed to degrade gracefully to pure polling on
// any listener error, and the pure payload + wake-key logic below is unit-tested directly.

import { createRequire } from 'node:module'
import type { CloudSseReplayHub } from './sse-replay.ts'

const require = createRequire(import.meta.url)

// A single LISTEN channel for the whole accelerator; the payload says which topic(s) to
// wake. Postgres NOTIFY payloads are capped at ~8000 bytes, so the payload carries
// IDENTIFIERS ONLY — never event bodies.
export const CLOUD_SSE_NOTIFY_CHANNEL = 'open_cowork_cloud_sse'

// Wake-key derivation. The sse-replay hub topic key embeds the SUBSCRIBER userId for
// sessions, so many users watching one session map to distinct topics; the wake key
// drops the subscriber dimension so a single session NOTIFY wakes them all. Both the HTTP
// subscribe path and the NOTIFY decode build these keys from the SAME components in the
// SAME order, so the hub's Map equality matches regardless of separator collisions inside
// the identifiers (no key is ever parsed back apart).
export function sessionSseWakeKey(tenantId: string, sessionId: string): string {
  return `session:${tenantId}:${sessionId}`
}

export function workspaceSseWakeKey(tenantId: string, userId: string): string {
  return `workspace:${tenantId}:${userId}`
}

export type SsePgNotifyPayload =
  | { kind: 'session'; tenantId: string; sessionId: string }
  | { kind: 'workspace'; tenantId: string; userId: string }

// Compact wire form: { k, t, ... }. Short keys keep the payload well under the NOTIFY
// size cap even for long tenant/session/user identifiers.
export function encodeSsePgNotifyPayload(payload: SsePgNotifyPayload): string {
  if (payload.kind === 'session') {
    return JSON.stringify({ k: 's', t: payload.tenantId, s: payload.sessionId })
  }
  return JSON.stringify({ k: 'w', t: payload.tenantId, u: payload.userId })
}

// Defensive decode: any malformed, partial, or unknown payload returns [] so the LISTEN
// handler never throws and never wakes the wrong topic — an undecodable NOTIFY simply
// wakes nothing (the poll loop still delivers).
export function ssePgNotifyWakeKeys(raw: string): string[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const record = parsed as Record<string, unknown>
  const tenantId = typeof record.t === 'string' && record.t.length > 0 ? record.t : null
  if (!tenantId) return []
  if (record.k === 's') {
    const sessionId = typeof record.s === 'string' && record.s.length > 0 ? record.s : null
    return sessionId ? [sessionSseWakeKey(tenantId, sessionId)] : []
  }
  if (record.k === 'w') {
    const userId = typeof record.u === 'string' && record.u.length > 0 ? record.u : null
    return userId ? [workspaceSseWakeKey(tenantId, userId)] : []
  }
  return []
}

// Minimal slice of the node-postgres Client surface the listener needs. Kept as a
// structural type so tests can inject a fake client and drive notification/error/end
// without a real Postgres connection.
export type CloudSsePgNotifyClient = {
  connect(): Promise<void>
  query(text: string): Promise<unknown>
  on(event: 'notification', handler: (message: { channel?: string; payload?: string }) => void): void
  on(event: 'error' | 'end', handler: (error?: unknown) => void): void
  removeAllListeners?(): void
  end(): Promise<void>
}

export type CloudSsePgNotifyListenerOptions = {
  connectionString: string
  // Only wake() is used; typed as a slice so a bare stub satisfies it in tests.
  hub: Pick<CloudSseReplayHub, 'wake'>
  channel?: string
  // Injectable so tests drive the lifecycle without `pg`. Defaults to a real pg Client.
  createClient?: (connectionString: string, channel: string) => CloudSsePgNotifyClient
  // Best-effort observability hook for connection/decoding failures. Must not throw.
  onError?: (error: unknown) => void
  initialBackoffMs?: number
  maxBackoffMs?: number
}

function defaultCreateClient(connectionString: string): CloudSsePgNotifyClient {
  const pg = require('pg') as { Client: new (options: { connectionString: string; application_name?: string }) => CloudSsePgNotifyClient }
  return new pg.Client({ connectionString, application_name: 'open-cowork-cloud-sse-listen' })
}

// A dedicated, long-lived LISTEN connection (NOT a pooled client — LISTEN holds the
// connection for its lifetime, which would otherwise starve the request pool). It
// reconnects with exponential backoff on any error/disconnect, never throws into the
// delivery path, and is torn down on close(). A listener failure degrades to pure polling.
export class CloudSsePgNotifyListener {
  private readonly connectionString: string
  private readonly hub: Pick<CloudSseReplayHub, 'wake'>
  private readonly channel: string
  private readonly createClient: (connectionString: string, channel: string) => CloudSsePgNotifyClient
  private readonly onError?: (error: unknown) => void
  private readonly initialBackoffMs: number
  private readonly maxBackoffMs: number

  private client: CloudSsePgNotifyClient | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs: number
  private connecting = false
  private closed = false

  constructor(options: CloudSsePgNotifyListenerOptions) {
    this.connectionString = options.connectionString
    this.hub = options.hub
    this.channel = options.channel ?? CLOUD_SSE_NOTIFY_CHANNEL
    // The channel is a fixed, validated identifier — guard anyway so it can never be
    // interpolated into LISTEN as anything but a quoted identifier.
    if (!/^[a-z_][a-z0-9_]*$/.test(this.channel)) {
      throw new Error(`Invalid Postgres LISTEN channel "${this.channel}".`)
    }
    this.createClient = options.createClient ?? defaultCreateClient
    this.onError = options.onError
    this.initialBackoffMs = Math.max(1, options.initialBackoffMs ?? 250)
    this.maxBackoffMs = Math.max(this.initialBackoffMs, options.maxBackoffMs ?? 30_000)
    this.backoffMs = this.initialBackoffMs
  }

  start(): void {
    if (this.closed) return
    void this.connect()
  }

  private async connect(): Promise<void> {
    if (this.closed || this.connecting || this.client) return
    this.connecting = true
    let client: CloudSsePgNotifyClient | null = null
    try {
      client = this.createClient(this.connectionString, this.channel)
      client.on('notification', (message) => this.handleNotification(message))
      client.on('error', (error) => this.handleConnectionDrop(error))
      client.on('end', () => this.handleConnectionDrop(undefined))
      await client.connect()
      await client.query(`LISTEN "${this.channel}"`)
      if (this.closed) {
        await safeEnd(client)
        return
      }
      this.client = client
      // Successful (re)connect: reset backoff so the next failure starts from the floor.
      this.backoffMs = this.initialBackoffMs
    } catch (error) {
      this.reportError(error)
      if (client) await safeEnd(client)
      this.scheduleReconnect()
    } finally {
      this.connecting = false
    }
  }

  private handleNotification(message: { channel?: string; payload?: string }): void {
    try {
      if (message.channel && message.channel !== this.channel) return
      const raw = message.payload
      if (typeof raw !== 'string' || raw.length === 0) return
      for (const key of ssePgNotifyWakeKeys(raw)) this.hub.wake(key)
    } catch (error) {
      // A bad payload must never break the listener; the poll loop still delivers.
      this.reportError(error)
    }
  }

  private handleConnectionDrop(error: unknown): void {
    if (error !== undefined) this.reportError(error)
    if (this.closed) return
    const client = this.client
    this.client = null
    if (client) void safeEnd(client)
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const base = this.backoffMs
    this.backoffMs = Math.min(this.maxBackoffMs, this.backoffMs * 2)
    // Jitter avoids a thundering herd of pods reconnecting in lockstep after a blip.
    const delay = base + Math.floor(Math.random() * Math.min(250, base))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
    this.reconnectTimer.unref?.()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const client = this.client
    this.client = null
    if (client) await safeEnd(client)
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error)
    } catch {
      // Observability must never destabilise the listener.
    }
  }
}

async function safeEnd(client: CloudSsePgNotifyClient): Promise<void> {
  try {
    // Drop our handlers first so end()'s own 'end' event cannot re-enter the drop path.
    client.removeAllListeners?.()
    await client.end()
  } catch {
    // Teardown is best-effort; a failed end() must not throw into shutdown/reconnect.
  }
}
