import { createCloudAdminClient } from './domains/admin.js'
import { createCloudAdminGovernanceClient } from './domains/admin-governance.js'
import { createCloudArtifactsClient } from './domains/artifacts.js'
import { createCloudBillingClient } from './domains/billing.js'
import { createCloudByokClient } from './domains/byok.js'
import { createCloudCapabilitiesClient } from './domains/capabilities.js'
import { createCloudChannelsClient } from './domains/channels.js'
import { createCloudConfigClient } from './domains/config.js'
import { createCloudIdentityClient } from './domains/identity.js'
import { createCloudLaunchpadClient } from './domains/launchpad.js'
import { createCloudSessionsClient } from './domains/sessions.js'
import { createCloudSettingsClient } from './domains/settings.js'
import { createCloudThreadsClient } from './domains/threads.js'
import { createCloudTransportEventClient } from './domains/transport.js'
import { createCloudWorkflowsClient } from './domains/workflows.js'
import { CloudTransportError, isCloudTransportError, type CloudTransportErrorKind } from './errors.js'
import type {
  CloudTransportAdapter,
  CloudTransportAdapterOptions,
  CloudTransportFetch,
} from './contracts.js'

export { CloudTransportError, isCloudTransportError } from './errors.js'
export type * from './contracts.js'
export type { CloudTransportErrorKind, CloudTransportErrorOptions } from './errors.js'

type ApiErrorPayload = {
  error?: string
  code?: string
}

function normalizeBaseUrl(baseUrl: string | undefined) {
  let normalized = baseUrl || ''
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  return normalized
}

function normalizeRequestTimeoutMs(value: number | null | undefined) {
  if (value === undefined || value === null) return 30_000
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(120_000, Math.max(100, Math.floor(value)))
}

function cloudApiRequestUrl(baseUrl: string, path: string) {
  if (!path.startsWith('/api/')) {
    throw new CloudTransportError({
      kind: 'request',
      message: 'Cloud transport path must target an API route.',
      url: path,
    })
  }
  return `${baseUrl}${path}`
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

async function parseJson<T>(
  response: Awaited<ReturnType<CloudTransportFetch>>,
  url: string,
  method: string,
): Promise<T> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw new CloudTransportError({
      kind: 'network',
      message: `Cloud transport failed to read response body: ${method} ${url}`,
      method,
      url,
      status: response.status,
      cause: error,
    })
  }
  if (!response.ok) {
    const body = parseApiErrorPayload(text)
    throw new CloudTransportError({
      kind: cloudTransportErrorKindForStatus(response.status),
      message: apiErrorMessage(body, `Cloud transport request failed with HTTP ${response.status}: ${method} ${url}`),
      method,
      url,
      status: response.status,
      retryAfter: responseHeader(response, 'retry-after'),
      code: apiErrorCode(body),
      body,
    })
  }
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch (error) {
    throw new CloudTransportError({
      kind: 'parse',
      message: `Cloud transport response was not valid JSON: ${method} ${url}`,
      method,
      url,
      status: response.status,
      body: text,
      cause: error,
    })
  }
}

export function createHttpSseCloudTransportAdapter(
  options: CloudTransportAdapterOptions = {},
): CloudTransportAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetcher = options.fetch || (globalThis.fetch as unknown as CloudTransportFetch)
  const headers = {
    ...(options.headers || {}),
  }
  const requestTimeoutMs = normalizeRequestTimeoutMs(options.requestTimeoutMs)

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
    const requestUrl = cloudApiRequestUrl(baseUrl, path)
    const controller = new AbortController()
    const detachAbortSignal = attachAbortSignal(controller, options.signal)
    let timedOut = false
    const timeout = requestTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        controller.abort(new CloudTransportError({
          kind: 'timeout',
          message: `Cloud transport request timed out after ${requestTimeoutMs}ms: ${method} ${path}`,
          method,
          url: requestUrl,
        }))
      }, requestTimeoutMs)
      : null
    const timeoutHandle = timeout as unknown as { unref?: () => void } | null
    timeoutHandle?.unref?.()
    try {
      // This transport intentionally sends authenticated cloud API payloads, including
      // user-selected artifact uploads that callers validate and authorize upstream.
      // lgtm[js/file-access-to-http]
      const response = await fetcher(requestUrl, {
        method,
        headers: nextHeaders,
        body,
        credentials: options.credentials,
        signal: controller.signal,
      })
      return parseJson<T>(response, requestUrl, method)
    } catch (error) {
      if (isCloudTransportError(error)) throw error
      if (timedOut) {
        throw new CloudTransportError({
          kind: 'timeout',
          message: `Cloud transport request timed out after ${requestTimeoutMs}ms: ${method} ${path}`,
          method,
          url: requestUrl,
          cause: error,
        })
      }
      if (options.signal?.aborted || controller.signal.aborted) {
        throw new CloudTransportError({
          kind: 'abort',
          message: `Cloud transport request was aborted: ${method} ${path}`,
          method,
          url: requestUrl,
          cause: error,
        })
      }
      throw new CloudTransportError({
        kind: 'network',
        message: `Cloud transport network request failed: ${method} ${path}`,
        method,
        url: requestUrl,
        cause: error,
      })
    } finally {
      if (timeout) clearTimeout(timeout)
      detachAbortSignal()
    }
  }

  // Raw-text reader for streamed downloads (audit export JSON/CSV): unlike
  // `request`, it does not JSON-parse the body and preserves the content-type +
  // content-disposition filename the server attaches.
  async function requestText(path: string) {
    const requestUrl = cloudApiRequestUrl(baseUrl, path)
    // lgtm[js/file-access-to-http]
    const response = await fetcher(requestUrl, {
      method: 'GET',
      headers: { ...headers },
      credentials: options.credentials,
    })
    const content = await response.text()
    if (!response.ok) {
      throw new CloudTransportError({
        kind: cloudTransportErrorKindForStatus(response.status),
        message: apiErrorMessage(parseApiErrorPayload(content), `Cloud transport request failed with HTTP ${response.status}: GET ${requestUrl}`),
        method: 'GET',
        url: requestUrl,
        status: response.status,
      })
    }
    const disposition = responseHeader(response, 'content-disposition') || ''
    const match = /filename="?([^"]+)"?/.exec(disposition)
    return {
      content,
      contentType: responseHeader(response, 'content-type') || '',
      filename: match ? match[1]! : null,
    }
  }

  const domainContext = { request }
  const sseContext = {
    baseUrl,
    fetcher,
    headers,
    credentials: options.credentials,
    signal: options.signal,
    eventSource: options.eventSource,
  }

  return {
    ...createCloudConfigClient(domainContext),
    ...createCloudSessionsClient(domainContext),
    ...createCloudWorkflowsClient(domainContext),
    ...createCloudThreadsClient(domainContext),
    ...createCloudArtifactsClient(domainContext),
    ...createCloudLaunchpadClient(domainContext),
    ...createCloudCapabilitiesClient(domainContext),
    ...createCloudSettingsClient(domainContext),
    ...createCloudByokClient(domainContext),
    ...createCloudBillingClient(domainContext),
    ...createCloudIdentityClient(domainContext),
    ...createCloudAdminClient(domainContext),
    ...createCloudAdminGovernanceClient({ ...domainContext, requestText }),
    ...createCloudChannelsClient({
      ...domainContext,
      ...sseContext,
    }),
    ...createCloudTransportEventClient(sseContext),
  }
}
