import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import {
  COWORK_CHANNEL_SCHEMA_VERSION,
  type LocalWebhookReceiverStatus,
} from '@open-cowork/shared'
import { getAppConfig } from './config-loader.ts'
import { deliverChannelDesktopNotification } from './channel-delivery.ts'
import {
  listLocalWebhookPairings,
  recordChannelInboundItem,
  verifyLocalWebhookPairingToken,
} from './channel-store.ts'
import { log } from './logger.ts'
import { loadSettings } from './settings.ts'

export type LocalWebhookReceiverConfig = {
  enabled?: boolean
  host?: string
  port?: number
}

type NormalizedReceiverConfig = {
  enabled: boolean
  host: '127.0.0.1' | '::1' | 'localhost'
  port: number
}

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024
const MAX_SOURCE_KEY_BYTES = 256
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])
const DEFAULT_RECEIVER_CONFIG: NormalizedReceiverConfig = {
  enabled: false,
  host: '127.0.0.1',
  port: 0,
}

let receiverServer: Server | null = null
let receiverState: Omit<LocalWebhookReceiverStatus, 'schemaVersion' | 'pairedChannels'> = {
  enabled: false,
  listening: false,
  host: DEFAULT_RECEIVER_CONFIG.host,
  port: null,
  url: null,
  lastError: null,
}

function normalizeReceiverConfig(config?: LocalWebhookReceiverConfig | null): NormalizedReceiverConfig {
  const host = LOOPBACK_HOSTS.has(String(config?.host || ''))
    ? config?.host as NormalizedReceiverConfig['host']
    : DEFAULT_RECEIVER_CONFIG.host
  const port = typeof config?.port === 'number' && Number.isInteger(config.port) && config.port >= 0 && config.port <= 65535
    ? config.port
    : DEFAULT_RECEIVER_CONFIG.port
  return {
    enabled: config?.enabled === true,
    host,
    port,
  }
}

function configuredReceiverConfig() {
  return normalizeReceiverConfig(getAppConfig().channels?.localWebhook)
}

function firstHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function bearerToken(req: IncomingMessage) {
  const auth = firstHeader(req.headers.authorization)?.trim() || ''
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice('bearer '.length).trim()
  return firstHeader(req.headers['x-open-cowork-channel-token'])?.trim() || ''
}

function respondJson(res: ServerResponse, statusCode: number, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload)
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body, 'utf8'),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    let totalBytes = 0
    let settled = false

    const fail = (error: Error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (settled) return
      totalBytes += Buffer.byteLength(chunk, 'utf8')
      if (totalBytes > MAX_WEBHOOK_BODY_BYTES) {
        fail(new Error('too_large'))
        req.resume()
        return
      }
      raw += chunk
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      let parsed: unknown
      try {
        parsed = JSON.parse(raw || '{}') as unknown
      } catch {
        reject(new Error('invalid_json'))
        return
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        reject(new Error('payload_object_required'))
        return
      }
      resolve(parsed as Record<string, unknown>)
    })
    req.on('error', fail)
    req.on('aborted', () => fail(new Error('aborted')))
  })
}

function payloadString(value: unknown, label: string) {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  return value
}

function payloadOptionalString(value: unknown, label: string) {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`)
  return value
}

function sourceKeyLooksValid(value: string) {
  return Buffer.byteLength(value, 'utf8') <= MAX_SOURCE_KEY_BYTES && /^[a-zA-Z0-9_.:-]+$/.test(value)
}

function sourceKeyFromRequest(req: IncomingMessage) {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const match = /^\/channels\/local-webhook\/([^/]+)$/.exec(url.pathname)
    if (!match) return null
    const sourceKey = decodeURIComponent(match[1] || '')
    return sourceKey && sourceKeyLooksValid(sourceKey) ? sourceKey : null
  } catch {
    return null
  }
}

function webhookPayloadErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (message === 'too_large') return { statusCode: 413, error: 'payload_too_large' }
  if (message === 'invalid_json') return { statusCode: 400, error: 'invalid_json' }
  if (message === 'payload_object_required') return { statusCode: 400, error: 'payload_object_required' }
  return { statusCode: 400, error: 'invalid_payload' }
}

async function handleLocalWebhookRequest(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== 'POST') {
    respondJson(res, 405, { ok: false, error: 'method_not_allowed' })
    return
  }

  const sourceKey = sourceKeyFromRequest(req)
  if (!sourceKey) {
    respondJson(res, 404, { ok: false, error: 'unknown_webhook_route' })
    return
  }

  const token = bearerToken(req)
  if (!token) {
    respondJson(res, 401, { ok: false, error: 'missing_pairing_token' })
    return
  }

  const paired = verifyLocalWebhookPairingToken(sourceKey, token)
  if (!paired) {
    log('security', `Rejected local webhook request for ${sourceKey}: invalid pairing token`)
    respondJson(res, 401, { ok: false, error: 'invalid_pairing_token' })
    return
  }

  try {
    const payload = await readJsonBody(req)
    const item = recordChannelInboundItem({
      channelId: paired.channel.id,
      sender: payloadString(payload.sender, 'sender'),
      subject: payloadOptionalString(payload.subject, 'subject'),
      body: payloadString(payload.body, 'body'),
      externalMessageId: payloadOptionalString(payload.externalMessageId, 'externalMessageId'),
      replyTarget: payloadOptionalString(payload.replyTarget, 'replyTarget'),
    })
    log('channel', `Recorded local webhook item ${item.id} for ${sourceKey} with status ${item.status}`)
    try {
      deliverChannelDesktopNotification({ item, settings: loadSettings() })
    } catch (notificationError) {
      const message = notificationError instanceof Error ? notificationError.message : String(notificationError)
      log('error', `Failed to deliver local webhook notification for ${item.id}: ${message}`)
    }
    respondJson(res, 202, {
      ok: true,
      itemId: item.id,
      status: item.status,
      auditState: item.auditState,
      queueItemId: item.queueItemId,
      deliveryRecordId: item.deliveryRecordId,
    })
  } catch (error) {
    const response = webhookPayloadErrorResponse(error)
    respondJson(res, response.statusCode, { ok: false, error: response.error })
  }
}

function currentReceiverUrl() {
  if (!receiverState.listening || !receiverState.port) return null
  const host = receiverState.host === '::1' ? '[::1]' : receiverState.host
  return `http://${host}:${receiverState.port}/channels/local-webhook/:sourceKey`
}

export function getLocalWebhookReceiverStatus(): LocalWebhookReceiverStatus {
  return {
    schemaVersion: COWORK_CHANNEL_SCHEMA_VERSION,
    ...receiverState,
    url: currentReceiverUrl(),
    pairedChannels: listLocalWebhookPairings().length,
  }
}

export async function startLocalWebhookReceiver(config: LocalWebhookReceiverConfig = configuredReceiverConfig()) {
  const normalized = normalizeReceiverConfig(config)
  if (!normalized.enabled) {
    if (receiverServer) await stopLocalWebhookReceiver()
    receiverState = {
      enabled: false,
      listening: false,
      host: normalized.host,
      port: null,
      url: null,
      lastError: null,
    }
    return getLocalWebhookReceiverStatus()
  }
  if (receiverServer) return getLocalWebhookReceiverStatus()

  receiverState = {
    enabled: true,
    listening: false,
    host: normalized.host,
    port: null,
    url: null,
    lastError: null,
  }

  const server = createServer((req, res) => {
    void handleLocalWebhookRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      log('error', `Local webhook request failed: ${message}`)
      if (!res.headersSent) respondJson(res, 500, { ok: false, error: 'internal_error' })
      else res.end()
    })
  })
  server.on('clientError', (_error, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  await new Promise<void>((resolve) => {
    const onError = (error: Error) => {
      server.off('listening', onListening)
      receiverServer = null
      receiverState = {
        ...receiverState,
        listening: false,
        port: null,
        url: null,
        lastError: error.message,
      }
      log('error', `Local webhook receiver failed to listen: ${error.message}`)
      resolve()
    }
    const onListening = () => {
      server.off('error', onError)
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : normalized.port
      receiverServer = server
      receiverState = {
        enabled: true,
        listening: true,
        host: normalized.host,
        port,
        url: null,
        lastError: null,
      }
      log('channel', `Local webhook receiver listening on ${normalized.host}:${port}`)
      resolve()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(normalized.port, normalized.host)
  })

  return getLocalWebhookReceiverStatus()
}

export async function stopLocalWebhookReceiver() {
  const server = receiverServer
  receiverServer = null
  if (server) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }
  receiverState = {
    ...receiverState,
    listening: false,
    port: null,
    url: null,
  }
}
