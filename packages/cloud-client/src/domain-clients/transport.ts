export type {
  CloudTransportAdapter,
  CloudTransportAdapterOptions,
  CloudTransportEventSource,
  CloudTransportFetch,
  CloudTransportResponse,
  CloudTransportSessionEvent,
  CloudTransportSubscription,
  CloudTransportWorkspaceEvent,
} from '../contracts.js'

export {
  CloudTransportError,
  isCloudTransportError,
} from '../errors.js'

export type {
  CloudTransportErrorKind,
  CloudTransportErrorOptions,
} from '../errors.js'

import { CLOUD_SESSION_EVENT_TYPES } from '@open-cowork/shared'
import {
  CloudTransportError,
  isCloudTransportError,
  type CloudTransportErrorKind,
  type CloudTransportErrorOptions,
} from '../errors.js'
import type {
  CloudTransportEventSource,
  CloudTransportFetch,
  CloudTransportSessionEvent,
  CloudTransportSubscription,
  CloudTransportWorkspaceEvent,
} from '../contracts.js'
import { encodePath } from '../domains/shared.js'

type ApiErrorPayload = {
  error?: string
  code?: string
}

export type CloudTransportSseContext = {
  baseUrl: string
  fetcher: CloudTransportFetch
  headers?: Record<string, string>
  credentials?: 'include'
  signal?: AbortSignal
  eventSource?: CloudTransportEventSource
}

export type CloudTransportEventClient = {
  workspaceEventsUrl(afterSequence?: number): string
  sessionEventsUrl(sessionId: string, afterSequence?: number): string
  subscribeWorkspaceEvents(input: {
    afterSequence?: number
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  subscribeSessionEvents(
    sessionId: string,
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription
}

export function sessionEventsUrl(baseUrl: string, sessionId: string, afterSequence = 0) {
  const path = `${baseUrl}/api/sessions/${encodePath(sessionId)}/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

export function workspaceEventsUrl(baseUrl: string, afterSequence = 0) {
  const path = `${baseUrl}/api/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

export function createCloudTransportEventClient(context: CloudTransportSseContext): CloudTransportEventClient {
  return {
    workspaceEventsUrl(afterSequence = 0) {
      return workspaceEventsUrl(context.baseUrl, afterSequence)
    },
    sessionEventsUrl(sessionId, afterSequence = 0) {
      return sessionEventsUrl(context.baseUrl, sessionId, afterSequence)
    },
    subscribeWorkspaceEvents(input) {
      return subscribeCloudEvents(context, workspaceEventsUrl(context.baseUrl, input.afterSequence), {
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
    subscribeSessionEvents(sessionId, input) {
      return subscribeCloudEvents(context, sessionEventsUrl(context.baseUrl, sessionId, input.afterSequence), {
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
  }
}

export function subscribeCloudEvents(
  context: CloudTransportSseContext,
  url: string,
  input: {
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
    onClose?: () => void
  },
): CloudTransportSubscription {
  const headers = context.headers || {}
  if (Object.keys(headers).length > 0) {
    return subscribeFetchSse(context.fetcher, url, {
      headers,
      credentials: context.credentials,
      signal: context.signal,
      onEvent: input.onEvent,
      onError: input.onError,
      onClose: input.onClose,
    })
  }
  const EventSourceImpl = context.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
  if (!EventSourceImpl) throw new Error('EventSource is not available for cloud transport subscriptions.')
  return subscribeEventSource(EventSourceImpl, url, {
    credentials: context.credentials,
    signal: context.signal,
    onEvent: input.onEvent,
    onError: input.onError,
  })
}

function subscribeEventSource(
  EventSourceImpl: CloudTransportEventSource,
  url: string,
  input: {
    credentials?: 'include'
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
    signal?: AbortSignal
  },
) {
  let source: InstanceType<CloudTransportEventSource>
  try {
    source = new EventSourceImpl(url, {
      withCredentials: input.credentials === 'include',
    })
  } catch (error) {
    throw new CloudTransportError({
      kind: 'sse',
      message: `Cloud transport EventSource subscription failed to start: ${url}`,
      url,
      cause: error,
    })
  }
  let closed = false
  const onEvent = (event: { data: string }) => {
    try {
      const parsed = JSON.parse(event.data) as CloudTransportWorkspaceEvent
      input.onEvent(parsed)
    } catch (error) {
      if (!closed) {
        input.onError?.(new CloudTransportError({
          kind: 'parse',
          message: `Cloud transport EventSource payload was not valid JSON: ${url}`,
          url,
          body: event.data,
          cause: error,
        }))
      }
    }
  }
  source.onmessage = onEvent
  for (const type of CLOUD_SESSION_EVENT_TYPES) source.addEventListener(type, onEvent)
  source.onerror = (error) => {
    if (!closed) {
      input.onError?.(new CloudTransportError({
        kind: 'sse',
        message: `Cloud transport EventSource subscription failed: ${url}`,
        url,
        cause: error,
      }))
    }
  }
  const abort = () => {
    closed = true
    source.close()
  }
  if (input.signal?.aborted) abort()
  else input.signal?.addEventListener('abort', abort, { once: true })
  return {
    close() {
      closed = true
      input.signal?.removeEventListener('abort', abort)
      source.close()
    },
  }
}

function subscribeFetchSse(
  fetcher: CloudTransportFetch,
  url: string,
  input: {
    headers?: Record<string, string>
    credentials?: 'include'
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
    // Fired once when the server ends the stream gracefully without the consumer calling close()
    // (idle timeout, deploy, scale/LB event). A clean end produces no read error, so without this
    // the consumer can't tell a healthy idle stream from a silently-dropped one. Consumer-initiated
    // close() does NOT fire it.
    onClose?: () => void
    signal?: AbortSignal
  },
) {
  const controller = new AbortController()
  let closed = false
  const detachAbortSignal = attachAbortSignal(controller, input.signal, () => {
    closed = true
  })

  const dispatch = (dataLines: string[]) => {
    if (dataLines.length === 0) return
    const payload = dataLines.join('\n')
    let parsed: CloudTransportWorkspaceEvent
    try {
      parsed = JSON.parse(payload) as CloudTransportWorkspaceEvent
    } catch (error) {
      throw new CloudTransportError({
        kind: 'parse',
        message: `Cloud transport SSE payload was not valid JSON: ${url}`,
        url,
        body: payload,
        cause: error,
      })
    }
    input.onEvent(parsed)
  }

  void (async () => {
    try {
      const response = await fetcher(url, {
        method: 'GET',
        headers: {
          ...(input.headers || {}),
          accept: 'text/event-stream',
        },
        credentials: input.credentials,
        signal: controller.signal,
      })
      if (!response.ok) {
        const text = await response.text()
        const body = parseApiErrorPayload(text)
        throw new CloudTransportError({
          kind: cloudTransportErrorKindForStatus(response.status),
          message: apiErrorMessage(body, `Cloud transport SSE subscription failed with HTTP ${response.status}: ${url}`),
          method: 'GET',
          url,
          status: response.status,
          retryAfter: responseHeader(response, 'retry-after'),
          code: apiErrorCode(body),
          body,
        })
      }
      if (!response.body) {
        throw new CloudTransportError({
          kind: 'sse',
          message: `Cloud transport SSE response did not include a readable stream: ${url}`,
          method: 'GET',
          url,
          status: response.status,
        })
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffered = ''
      let dataLines: string[] = []

      const processLine = (rawLine: string) => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') {
          dispatch(dataLines)
          dataLines = []
          return
        }
        if (line.startsWith(':')) return
        const delimiter = line.indexOf(':')
        const field = delimiter === -1 ? line : line.slice(0, delimiter)
        const value = delimiter === -1
          ? ''
          : line.slice(delimiter + 1).replace(/^ /, '')
        if (field === 'data') dataLines.push(value)
      }

      try {
        while (!closed) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffered += decoder.decode(chunk.value, { stream: true })
          let newlineIndex = buffered.indexOf('\n')
          while (newlineIndex >= 0) {
            processLine(buffered.slice(0, newlineIndex))
            buffered = buffered.slice(newlineIndex + 1)
            newlineIndex = buffered.indexOf('\n')
          }
        }
        buffered += decoder.decode()
        if (buffered) processLine(buffered)
        dispatch(dataLines)
      } finally {
        reader.releaseLock()
      }
      // The stream ended without the consumer closing it: a graceful server-initiated close
      // (idle timeout / deploy / scale event). Surface it so the consumer can resubscribe instead
      // of silently treating the dead pipe as healthy.
      if (!closed) input.onClose?.()
    } finally {
      detachAbortSignal()
    }
  })().catch((error) => {
    if (!closed) {
      input.onError?.(cloudTransportErrorFromUnknown(error, {
        kind: 'sse',
        message: `Cloud transport SSE subscription failed: ${url}`,
        method: 'GET',
        url,
      }))
    }
  })

  return {
    close() {
      closed = true
      detachAbortSignal()
      controller.abort()
    },
  }
}

function cloudTransportErrorKindForStatus(status: number): CloudTransportErrorKind {
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'forbidden'
  if (status === 402) return 'payment_required'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status === 429) return 'rate_limited'
  if (status >= 500) return 'server'
  return 'http'
}

function responseHeader(response: Awaited<ReturnType<CloudTransportFetch>>, name: string) {
  try {
    return response.headers?.get(name) || response.headers?.get(name.toLowerCase()) || null
  } catch {
    return null
  }
}

function errorMessageFromUnknown(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return fallback
}

function cloudTransportErrorFromUnknown(error: unknown, fallback: CloudTransportErrorOptions) {
  if (isCloudTransportError(error)) return error
  return new CloudTransportError({
    ...fallback,
    cause: error,
    message: fallback.message || errorMessageFromUnknown(error, 'Cloud transport request failed.'),
  })
}

function parseApiErrorPayload(text: string): ApiErrorPayload | string | null {
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as ApiErrorPayload
      : {}
  } catch {
    return text
  }
}

function apiErrorMessage(body: ApiErrorPayload | string | null, fallback: string) {
  if (typeof body === 'string' && body.trim()) return body
  if (body && typeof body !== 'string' && typeof body.error === 'string' && body.error.trim()) return body.error
  return fallback
}

function apiErrorCode(body: ApiErrorPayload | string | null) {
  return body && typeof body !== 'string' && typeof body.code === 'string' && body.code.trim()
    ? body.code
    : null
}

function attachAbortSignal(
  controller: AbortController,
  signal: AbortSignal | null | undefined,
  onAbort?: () => void,
) {
  if (!signal) return () => undefined
  const abort = () => {
    onAbort?.()
    controller.abort(signal.reason)
  }
  if (signal.aborted) {
    abort()
    return () => undefined
  }
  signal.addEventListener('abort', abort, { once: true })
  return () => signal.removeEventListener('abort', abort)
}
