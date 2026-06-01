import type { GatewayWorkspaceConnectionRecord } from './gateway-workspace-registry.ts'

export type GatewayWorkspaceHealth = {
  ok: boolean
  productMode?: string | null
  error?: string | null
}

export type GatewayWorkspaceReadiness = {
  ok: boolean
  error?: string | null
}

export type GatewayWorkspaceStatusAdapter = {
  health(): Promise<GatewayWorkspaceHealth>
  ready(): Promise<GatewayWorkspaceReadiness>
  sync(): Promise<void>
}

export type GatewayWorkspaceStatusAdapterOptions = {
  fetch?: typeof fetch
  requestTimeoutMs?: number
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeRemoteText(value: unknown, fallback: string): string {
  const message = text(value)
  if (!message) return fallback
  if (/(authorization|bearer|token|secret|api[-_\s]?key|password|credential)/i.test(message)) {
    return fallback
  }
  return message.slice(0, 240)
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const payload = await response.json().catch(() => ({}))
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
}

function normalizeRequestTimeoutMs(value: number | null | undefined) {
  if (value === undefined || value === null) return 10_000
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(60_000, Math.max(100, Math.floor(value)))
}

async function fetchGatewayJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  requestTimeoutMs: number,
) {
  const controller = new AbortController()
  const timeout = requestTimeoutMs > 0
    ? setTimeout(() => controller.abort(), requestTimeoutMs)
    : null
  try {
    const response = await fetcher(url, {
      headers,
      signal: controller.signal,
    })
    return response
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error('Gateway workspace request timed out.', { cause: error })
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function createGatewayWorkspaceAdapter(
  connection: GatewayWorkspaceConnectionRecord,
  token?: string | null,
  options: GatewayWorkspaceStatusAdapterOptions = {},
): GatewayWorkspaceStatusAdapter {
  const baseUrl = connection.baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {}
  const fetcher = options.fetch || fetch
  const requestTimeoutMs = normalizeRequestTimeoutMs(options.requestTimeoutMs)

  async function get(path: string): Promise<Record<string, unknown>> {
    const response = await fetchGatewayJson(fetcher, `${baseUrl}${path}`, headers, requestTimeoutMs)
    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(`Gateway workspace ${path} returned HTTP ${response.status}`)
    }
    return payload
  }

  return {
    async health() {
      try {
        const payload = await get('/health')
        return {
          ok: payload.ok === true,
          productMode: text(payload.productMode),
          error: safeRemoteText(payload.error, 'Gateway workspace reported unhealthy.'),
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    async ready() {
      try {
        const payload = await get('/ready')
        return {
          ok: payload.ok === true,
          error: safeRemoteText(payload.error, 'Gateway workspace reported not ready.'),
        }
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    },
    async sync() {
      const [health, readiness] = await Promise.all([this.health(), this.ready()])
      if (!health.ok) throw new Error(health.error || 'Gateway workspace health check failed.')
      if (!readiness.ok) throw new Error(readiness.error || 'Gateway workspace readiness check failed.')
    },
  }
}
