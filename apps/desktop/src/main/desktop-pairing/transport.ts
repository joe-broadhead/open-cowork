import type {
  DesktopPairingCommandClaimRequest,
  DesktopPairingCommandClaimResult,
  DesktopPairingCommandResult,
  DesktopPairingRecord,
  DesktopPairingRemoteEvent,
} from '@open-cowork/shared'
import type { DesktopPairingCredentialRecord } from './credentials.ts'
import { resolveDesktopPairingBrokerUrl } from './broker-url-policy.ts'

export type DesktopPairingTransportContext = {
  record: DesktopPairingRecord
  credential: DesktopPairingCredentialRecord
}

export type DesktopPairingTransport = {
  heartbeat(context: DesktopPairingTransportContext): Promise<void>
  claimCommands(
    context: DesktopPairingTransportContext,
    request: DesktopPairingCommandClaimRequest,
  ): Promise<DesktopPairingCommandClaimResult>
  ackCommand(
    context: DesktopPairingTransportContext,
    commandId: string,
    result: DesktopPairingCommandResult,
    leaseToken?: string | null,
  ): Promise<void>
  failCommand(
    context: DesktopPairingTransportContext,
    commandId: string,
    result: DesktopPairingCommandResult,
    leaseToken?: string | null,
  ): Promise<void>
  publishEvents(context: DesktopPairingTransportContext, events: DesktopPairingRemoteEvent[]): Promise<void>
  revoke?(context: DesktopPairingTransportContext): Promise<void>
}

type HttpJsonInput = {
  method?: string
  body?: unknown
}

const DEFAULT_TIMEOUT_MS = 15_000

function joinUrl(baseUrl: string, path: string) {
  return `${baseUrl.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function timeoutSignal(timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

export class HttpDesktopPairingTransport implements DesktopPairingTransport {
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}) {
    this.fetchImpl = options.fetchImpl || fetch
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  }

  async heartbeat(context: DesktopPairingTransportContext): Promise<void> {
    await this.json(context, '/api/desktop-pairing/heartbeat', {
      method: 'POST',
      body: {
        pairingId: context.record.id,
        deviceId: context.credential.deviceId,
        status: context.record.status,
        lastCommandSequence: context.record.lastCommandSequence,
      },
    })
  }

  async claimCommands(
    context: DesktopPairingTransportContext,
    request: DesktopPairingCommandClaimRequest,
  ): Promise<DesktopPairingCommandClaimResult> {
    const parsed = await this.json(context, '/api/desktop-pairing/commands/claim', {
      method: 'POST',
      body: request,
    })
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { commands: [] }
    const commands = Array.isArray((parsed as { commands?: unknown }).commands)
      ? (parsed as DesktopPairingCommandClaimResult).commands
      : []
    const remoteStatus = (parsed as DesktopPairingCommandClaimResult).remoteStatus
    return { commands, remoteStatus }
  }

  async ackCommand(
    context: DesktopPairingTransportContext,
    commandId: string,
    result: DesktopPairingCommandResult,
    leaseToken?: string | null,
  ): Promise<void> {
    await this.json(context, `/api/desktop-pairing/commands/${encodeURIComponent(commandId)}/ack`, {
      method: 'POST',
      body: { result, leaseToken: leaseToken || null },
    })
  }

  async failCommand(
    context: DesktopPairingTransportContext,
    commandId: string,
    result: DesktopPairingCommandResult,
    leaseToken?: string | null,
  ): Promise<void> {
    await this.json(context, `/api/desktop-pairing/commands/${encodeURIComponent(commandId)}/fail`, {
      method: 'POST',
      body: { result, leaseToken: leaseToken || null },
    })
  }

  async publishEvents(context: DesktopPairingTransportContext, events: DesktopPairingRemoteEvent[]): Promise<void> {
    if (events.length === 0) return
    await this.json(context, '/api/desktop-pairing/events', {
      method: 'POST',
      body: { events },
    })
  }

  async revoke(context: DesktopPairingTransportContext): Promise<void> {
    await this.json(context, '/api/desktop-pairing/revoke', {
      method: 'POST',
      body: {
        pairingId: context.record.id,
        deviceId: context.credential.deviceId,
      },
    })
  }

  private async json(context: DesktopPairingTransportContext, path: string, input: HttpJsonInput = {}) {
    if (!context.record.brokerUrl) {
      throw new Error('Desktop pairing broker URL is not configured.')
    }
    const brokerUrl = await resolveDesktopPairingBrokerUrl(context.record.brokerUrl)
    const { signal, clear } = timeoutSignal(this.timeoutMs)
    try {
      const response = await this.fetchImpl(joinUrl(brokerUrl, path), {
        method: input.method || 'GET',
        headers: {
          authorization: `Bearer ${context.credential.token}`,
          'content-type': 'application/json',
          'x-open-cowork-pairing-id': context.record.id,
          'x-open-cowork-device-id': context.credential.deviceId,
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        redirect: 'error',
        signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`Desktop pairing broker returned HTTP ${response.status}${text ? `: ${text.slice(0, 256)}` : ''}`)
      }
      if (response.status === 204) return null
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.includes('application/json')) return null
      return response.json() as Promise<unknown>
    } finally {
      clear()
    }
  }
}

export function createHttpDesktopPairingTransport() {
  return new HttpDesktopPairingTransport()
}
