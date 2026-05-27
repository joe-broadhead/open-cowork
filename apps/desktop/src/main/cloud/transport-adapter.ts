import type { SessionCommandRecord, SessionRecord } from './control-plane-store.ts'
import type { CloudSessionView } from './session-service.ts'

export type CloudRuntimeStatus = {
  role: string
  profileName: string
  canExecute: boolean
  commandProcessing: 'inline' | 'durable' | 'delegated'
  checkpoints: boolean
  heartbeats: unknown[]
}

export type CloudTransportConfig = {
  role: string
  profileName: string
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
}

export type CloudTransportResponse<T> = {
  status: number
  body: T
}

export type CloudTransportFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    credentials?: 'include'
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
}>

export type CloudTransportEventSource = new (
  url: string,
  init?: { withCredentials?: boolean },
) => {
  close(): void
  addEventListener(type: string, listener: (event: { data: string, lastEventId?: string }) => void): void
  onmessage: ((event: { data: string, lastEventId?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type CloudTransportAdapterOptions = {
  baseUrl?: string
  fetch?: CloudTransportFetch
  eventSource?: CloudTransportEventSource
  csrfToken?: string | null
  credentials?: 'include'
  headers?: Record<string, string>
}

export type CloudTransportSubscription = {
  close(): void
}

export type CloudTransportSessionEvent = {
  tenantId?: string
  sessionId?: string
  eventId: string
  sequence: number
  type: string
  payload: Record<string, unknown>
  createdAt?: string
}

export type CloudTransportAdapter = {
  getConfig(): Promise<CloudTransportConfig>
  getRuntimeStatus(): Promise<CloudRuntimeStatus>
  listSessions(): Promise<SessionRecord[]>
  createSession(input?: { profileName?: string | null }): Promise<CloudSessionView>
  getSession(sessionId: string): Promise<CloudSessionView>
  promptSession(sessionId: string, input: { text: string, agent?: string | null }): Promise<{
    command: SessionCommandRecord
    processed: number
    view: CloudSessionView
  }>
  abortSession(sessionId: string): Promise<{ command: SessionCommandRecord, processed: number, view: CloudSessionView }>
  replyToQuestion(sessionId: string, input: { requestId: string, answers: unknown[] }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  respondToPermission(sessionId: string, input: { permissionId: string, response: unknown }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  sessionEventsUrl(sessionId: string, afterSequence?: number): string
  subscribeSessionEvents(
    sessionId: string,
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription
}

type ApiErrorPayload = {
  error?: string
}

function normalizeBaseUrl(baseUrl: string | undefined) {
  return (baseUrl || '').replace(/\/+$/, '')
}

function encodePath(value: string) {
  return encodeURIComponent(value)
}

function eventUrl(baseUrl: string, sessionId: string, afterSequence = 0) {
  const path = `${baseUrl}/api/sessions/${encodePath(sessionId)}/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

async function parseJson<T>(response: Awaited<ReturnType<CloudTransportFetch>>, url: string): Promise<T> {
  const text = await response.text()
  const body = text ? JSON.parse(text) as T & ApiErrorPayload : {} as T & ApiErrorPayload
  if (!response.ok) {
    throw new Error(body.error || `Cloud transport request failed with HTTP ${response.status}: ${url}`)
  }
  return body
}

export function createHttpSseCloudTransportAdapter(
  options: CloudTransportAdapterOptions = {},
): CloudTransportAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetcher = options.fetch || (globalThis.fetch as unknown as CloudTransportFetch)
  const headers = {
    ...(options.headers || {}),
  }

  async function request<T>(path: string, init: {
    method?: string
    body?: unknown
  } = {}) {
    const method = init.method || 'GET'
    const nextHeaders: Record<string, string> = {
      ...headers,
    }
    let body: string | undefined
    if (init.body !== undefined) {
      nextHeaders['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    if (method !== 'GET' && options.csrfToken) {
      nextHeaders['x-csrf-token'] = options.csrfToken
    }
    return parseJson<T>(await fetcher(`${baseUrl}${path}`, {
      method,
      headers: nextHeaders,
      body,
      credentials: options.credentials,
    }), path)
  }

  return {
    getConfig() {
      return request<CloudTransportConfig>('/api/config')
    },
    getRuntimeStatus() {
      return request<CloudRuntimeStatus>('/api/runtime/status')
    },
    async listSessions() {
      return (await request<{ sessions: SessionRecord[] }>('/api/sessions')).sessions
    },
    createSession(input = {}) {
      return request<CloudSessionView>('/api/sessions', {
        method: 'POST',
        body: input,
      })
    },
    getSession(sessionId) {
      return request<CloudSessionView>(`/api/sessions/${encodePath(sessionId)}`)
    },
    promptSession(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/prompt`, {
        method: 'POST',
        body: input,
      })
    },
    abortSession(sessionId) {
      return request(`/api/sessions/${encodePath(sessionId)}/abort`, {
        method: 'POST',
        body: {},
      })
    },
    replyToQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reply`, {
        method: 'POST',
        body: input,
      })
    },
    respondToPermission(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/permission-respond`, {
        method: 'POST',
        body: input,
      })
    },
    sessionEventsUrl(sessionId, afterSequence = 0) {
      return eventUrl(baseUrl, sessionId, afterSequence)
    },
    subscribeSessionEvents(sessionId, input) {
      const EventSourceImpl = options.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
      if (!EventSourceImpl) throw new Error('EventSource is not available for cloud transport subscriptions.')
      const source = new EventSourceImpl(eventUrl(baseUrl, sessionId, input.afterSequence), {
        withCredentials: options.credentials === 'include',
      })
      const onEvent = (event: { data: string }) => {
        const parsed = JSON.parse(event.data) as CloudTransportSessionEvent
        input.onEvent(parsed)
      }
      source.onmessage = onEvent
      source.addEventListener('session.created', onEvent)
      source.addEventListener('prompt.submitted', onEvent)
      source.addEventListener('assistant.message', onEvent)
      source.addEventListener('runtime.error', onEvent)
      source.onerror = (error) => input.onError?.(error)
      return {
        close() {
          source.close()
        },
      }
    },
  }
}
