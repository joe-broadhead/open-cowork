/**
 * Live event stream for the gateway dashboard.
 *
 * Forwards opencode server SSE events to connected dashboard clients.
 * Events: session.created, session.updated, message.updated, tool calls, etc.
 */

import type { OpencodeClient } from '@opencode-ai/sdk'
import { queueEvent } from './wakeup.js'
import { getConfig } from './config.js'
import { isLocalOrigin, redactSensitiveText } from './security.js'
import { openCodeFetch } from './opencode-client.js'
import { createOpenCodeSessionRuntime } from './opencode-session-runtime.js'

interface LiveClient {
  id: string
  res: any
}

let liveClients: LiveClient[] = []
let subscribed = false
// Per-session payload of the last broadcast poll event, so an unchanged
// session is not re-broadcast to every client on every 5s poll.
const lastSessionUpdatePayloads = new Map<string, string>()
// A stalled SSE client must not buffer unbounded broadcast data in memory;
// past this many queued bytes the client is disconnected.
const MAX_SSE_CLIENT_BUFFERED_BYTES = 1_000_000

export function subscribeToOpenCodeEvents(client: OpencodeClient, onEvent?: (event: any) => void) {
  if (subscribed) return
  subscribed = true
  subscribeToNativeEvents(onEvent).catch(err => queueEvent(`OpenCode event stream unavailable: ${err?.message || err}`))

  // Safety net: polling keeps the dashboard fresh if SSE disconnects or misses events.
  setInterval(async () => {
    if (liveClients.length === 0) return
    try {
      const sessions = await createOpenCodeSessionRuntime(client).listSessions() as any[]
      if (!Array.isArray(sessions)) return

      const gw = sessions.filter((s: any) => (s.title || '').startsWith('GW:'))
      const seenIds = new Set<string>()
      for (const s of gw) {
        const event = {
          type: 'session_update',
          id: s.id,
          title: (s.title || '').replace('GW:', '').trim(),
          cost: s.cost || 0,
          tokens: s.tokens || {},
          updated: s.time?.updated || 0,
        }
        const payload = JSON.stringify(event)
        seenIds.add(String(s.id))
        if (lastSessionUpdatePayloads.get(String(s.id)) === payload) continue
        lastSessionUpdatePayloads.set(String(s.id), payload)
        broadcast(event, payload)
      }
      for (const id of lastSessionUpdatePayloads.keys()) {
        if (!seenIds.has(id)) lastSessionUpdatePayloads.delete(id)
      }
    } catch {}
  }, 5000)
}

async function subscribeToNativeEvents(onEvent?: (event: any) => void): Promise<void> {
  while (subscribed) {
    try {
      const res = await openCodeFetch(getConfig().opencodeUrl, 'global/event', { headers: { Accept: 'text/event-stream' } })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      queueEvent('OpenCode event stream connected')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (subscribed) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const frames = buffer.split('\n\n')
        buffer = frames.pop() || ''
        for (const frame of frames) {
          const event = parseSseFrame(frame)
          if (!event) continue
          broadcast(sanitizeOpenCodeEventForLive(event))
          if (event.type.includes('permission') || event.type.includes('question')) queueEvent(`OpenCode ${event.type}`)
          onEvent?.(event)
        }
      }
    } catch (err: any) {
      queueEvent(`OpenCode event stream disconnected: ${err?.message || err}`)
      await sleep(3000)
    }
  }
}

export function parseSseFrame(frame: string): { type: string; payload: any } | null {
  const eventType = frame.split('\n').find(line => line.startsWith('event:'))?.slice('event:'.length).trim()
  const data = frame.split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trimStart())
    .join('\n')
  if (!data || data === '[DONE]') return null
  let payload: any = data
  try { payload = JSON.parse(data) } catch {}
  return { type: eventType || payload?.type || 'message', payload }
}

export function sanitizeOpenCodeEventForLive(event: { type: string; payload: any }): Record<string, unknown> {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {}
  const info = objectValue(payload['info'])
  const session = objectValue(payload['session']) || objectValue(info?.['session'])
  const message = objectValue(payload['message']) || info
  const sessionId = stringValue(payload['sessionID']) || stringValue(payload['sessionId']) || stringValue(payload['session_id']) || stringValue(session?.['id']) || stringValue(message?.['sessionID']) || stringValue(message?.['sessionId'])
  const messageId = stringValue(payload['messageID']) || stringValue(payload['messageId']) || stringValue(message?.['id'])
  const title = stringValue(session?.['title']) || stringValue(payload['title'])
  return {
    type: 'opencode_event',
    eventType: String(event?.type || 'message'),
    ...(sessionId ? { sessionId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(title ? { title: redactSensitiveText(title, getConfig()) } : {}),
    updated: Date.now(),
  }
}

export function addLiveClient(id: string, res: any, origin?: string, port?: number) {
  liveClients.push({ id, res })
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    // The live stream carries session/work state; only a local origin (the
    // same-origin dashboard) may read it cross-origin. A non-local origin gets
    // the canonical loopback value, which no real remote origin can match —
    // NOT the literal 'null', which an opaque origin (sandboxed iframe,
    // file://, data:) would match and could use to EventSource-scrape the daemon.
    'Access-Control-Allow-Origin': origin && isLocalOrigin(origin) ? origin : `http://127.0.0.1:${port ?? 0}`,
    'Vary': 'Origin',
  })
  res.write('data: ' + JSON.stringify({ type: 'connected' }) + '\n\n')
  // Replay the last-known session snapshots so a fresh or reconnecting client
  // sees connect-time state instead of waiting for the next change to broadcast.
  for (const payload of lastSessionUpdatePayloads.values()) {
    try {
      res.write('data: ' + payload + '\n\n')
    } catch {
      removeLiveClient(id)
      break
    }
  }
}

export function removeLiveClient(id: string) {
  liveClients = liveClients.filter(c => c.id !== id)
}

export function closeAllLiveClients(): void {
  const clients = liveClients
  liveClients = []
  for (const client of clients) {
    try {
      client.res.end?.('event: shutdown\ndata: {"type":"shutdown"}\n\n')
    } catch {
      try { client.res.destroy?.() } catch {}
    }
  }
}

export function broadcastLiveEventForTest(event: any): void {
  broadcast(event)
}

export function liveClientCountForTest(): number {
  return liveClients.length
}

export function clearLiveClientsForTest(): void {
  liveClients = []
  lastSessionUpdatePayloads.clear()
}

export function primeSessionUpdatePayloadForTest(id: string, event: any): void {
  lastSessionUpdatePayloads.set(id, JSON.stringify(event))
}

function broadcast(event: any, serialized?: string) {
  if (liveClients.length === 0) return
  const data = 'data: ' + (serialized ?? JSON.stringify(event)) + '\n\n'
  for (const client of [...liveClients]) {
    try {
      // Backpressure: drop clients whose socket buffer keeps growing instead
      // of queueing unbounded data for a stalled consumer.
      if (Number(client.res.writableLength || 0) > MAX_SSE_CLIENT_BUFFERED_BYTES) {
        removeLiveClient(client.id)
        try { client.res.destroy?.() } catch {}
        continue
      }
      client.res.write(data)
    } catch {
      removeLiveClient(client.id)
    }
  }
}

function objectValue(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
