import {
  createOpencodeClient,
  type OpencodeClientConfig,
} from '@opencode-ai/sdk/v2'
import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { mkdirSync } from 'node:fs'
import {
  normalizeMessagePart,
  normalizeRuntimeEventEnvelope,
  normalizeSessionInfo,
} from '../opencode-adapter.ts'
import { buildManagedRuntimeEnvironment } from '../runtime-environment.ts'
import {
  createManagedOpencodeServerAuth,
  type ManagedOpencodeServerAuth,
  type ManagedOpencodeServerLogLevel,
  type ManagedOpencodeServerUnexpectedExit,
} from '../runtime-managed-server-core.ts'
import { createNodeManagedOpencodeServer } from '../runtime-node-managed-server.ts'
import type { PathProvider } from './path-provider.ts'
import {
  createSdkCloudRuntimeAdapter,
  type CloudRuntimeAdapter,
  type CloudRuntimeEvent,
  type CloudRuntimeEventListener,
} from './runtime-adapter.ts'

type EventCapableClient = {
  event?: {
    subscribe(
      input?: Record<string, never>,
      options?: { signal?: AbortSignal },
    ): Promise<{ stream: AsyncIterable<unknown> }>
  }
}

export type NodeOpencodeCloudRuntimeAdapter = CloudRuntimeAdapter & {
  url: string
  auth: ManagedOpencodeServerAuth
}

export type NodeOpencodeCloudRuntimeOptions = {
  paths: PathProvider
  config?: OpencodeServerOptions['config']
  env?: NodeJS.ProcessEnv
  hostname?: string
  port?: number
  timeout?: number
  logLevel?: ManagedOpencodeServerLogLevel
  opencodeBinPath?: string | null
  enableNativeWebSearch?: boolean
  onUnexpectedExit?: (event: ManagedOpencodeServerUnexpectedExit) => void
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function readNestedString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = readString(record[key])
    if (value) return value
  }
  return null
}

function readSessionId(properties: Record<string, unknown>) {
  const part = asRecord(properties.part)
  const info = asRecord(properties.info)
  const status = asRecord(properties.status)
  return readNestedString(properties, ['sessionID', 'sessionId'])
    || readNestedString(part, ['sessionID', 'sessionId'])
    || readNestedString(info, ['sessionID', 'sessionId'])
    || readNestedString(status, ['sessionID', 'sessionId'])
}

function readMessageId(properties: Record<string, unknown>) {
  const part = asRecord(properties.part)
  const info = asRecord(properties.info)
  return readNestedString(properties, ['messageID', 'messageId'])
    || readNestedString(part, ['messageID', 'messageId'])
    || readNestedString(info, ['id'])
}

function readErrorMessage(properties: Record<string, unknown>) {
  const error = asRecord(properties.error)
  return readNestedString(properties, ['message', 'error'])
    || readNestedString(error, ['message', 'error'])
    || 'OpenCode runtime reported an error.'
}

function eventFromMessagePartUpdated(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const part = normalizeMessagePart(properties.part)
  if (!part || part.type !== 'text' || !part.text) return []
  const role = readString(properties.role)
    || readString(asRecord(properties.info).role)
    || readString(asRecord(properties.message).role)
  if (role === 'user') return []
  const sessionId = readSessionId(properties)
  return [{
    type: 'assistant.message',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      messageId: readMessageId(properties) || part.id || undefined,
      content: part.text,
    },
  }]
}

function eventFromMessageUpdated(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const info = normalizeSessionInfo(properties.info)
  if (!info || info.role !== 'assistant') return []
  const parts = Array.isArray(properties.parts)
    ? properties.parts
    : Array.isArray(asRecord(properties.message).parts)
      ? asRecord(properties.message).parts as unknown[]
      : []
  const text = parts
    .map(normalizeMessagePart)
    .filter((part): part is NonNullable<ReturnType<typeof normalizeMessagePart>> => Boolean(part))
    .filter((part) => part.type === 'text' && Boolean(part.text))
    .map((part) => part.text)
    .join('')
  if (!text) return []
  return [{
    type: 'assistant.message',
    payload: {
      ...(info.sessionID ? { sessionId: info.sessionID } : {}),
      messageId: info.id,
      content: text,
    },
  }]
}

function eventFromSessionStatus(properties: Record<string, unknown>): CloudRuntimeEvent[] {
  const status = asRecord(properties.status)
  const sessionId = readSessionId(properties)
  return [{
    type: 'session.status',
    payload: {
      ...(sessionId ? { sessionId } : {}),
      statusType: readNestedString(status, ['type']) || readNestedString(properties, ['statusType', 'type']) || 'unknown',
    },
  }]
}

export function translateOpencodeRuntimeEvent(raw: unknown): CloudRuntimeEvent[] {
  const event = normalizeRuntimeEventEnvelope(raw)
  if (!event) return []
  const properties = event.properties || {}

  switch (event.type) {
    case 'message.part.updated':
      return eventFromMessagePartUpdated(properties)
    case 'message.updated':
      return eventFromMessageUpdated(properties)
    case 'session.idle':
      return [{
        type: 'session.idle',
        payload: {
          ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
        },
      }]
    case 'session.status':
      return eventFromSessionStatus(properties)
    case 'session.error':
    case 'session.failure':
      return [{
        type: 'runtime.error',
        payload: {
          ...(readSessionId(properties) ? { sessionId: readSessionId(properties) } : {}),
          message: readErrorMessage(properties),
        },
      }]
    default:
      return []
  }
}

export function subscribeToOpencodeCloudRuntimeEvents(
  client: EventCapableClient,
  listener: CloudRuntimeEventListener,
  options: { signal?: AbortSignal, onError?: (error: unknown) => void } = {},
) {
  if (!client.event?.subscribe) return () => undefined
  const controller = new AbortController()
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })

  void (async () => {
    try {
      const result = await client.event!.subscribe({}, { signal: controller.signal })
      for await (const raw of result.stream) {
        for (const event of translateOpencodeRuntimeEvent(raw)) {
          listener(event)
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) options.onError?.(error)
    }
  })()

  return () => {
    options.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

export function buildNodeOpencodeCloudRuntimeClientConfig(
  baseUrl: string,
  auth: ManagedOpencodeServerAuth,
): OpencodeClientConfig {
  return {
    baseUrl,
    headers: {
      Authorization: auth.authorizationHeader,
    },
  }
}

function ensureNodeRuntimeDirs(paths: PathProvider) {
  const roots = paths.getRuntimeXdgRoots()
  for (const path of [
    paths.getAppDataDir(),
    paths.getRuntimeHomeDir(),
    roots.home,
    roots.configHome,
    roots.dataHome,
    roots.stateHome,
    roots.cacheHome,
    paths.getWorkspaceRoot(),
    paths.getArtifactRoot(),
  ]) {
    mkdirSync(path, { recursive: true })
  }
}

export async function createNodeOpencodeCloudRuntimeAdapter(
  options: NodeOpencodeCloudRuntimeOptions,
): Promise<NodeOpencodeCloudRuntimeAdapter> {
  ensureNodeRuntimeDirs(options.paths)
  const auth = createManagedOpencodeServerAuth()
  const runtimePaths = options.paths.getRuntimeXdgRoots()
  const env = buildManagedRuntimeEnvironment({
    currentEnv: options.env || process.env,
    runtimePaths: {
      home: runtimePaths.home,
      configHome: runtimePaths.configHome,
      dataHome: runtimePaths.dataHome,
      stateHome: runtimePaths.stateHome,
      cacheHome: runtimePaths.cacheHome,
    },
    enableNativeWebSearch: options.enableNativeWebSearch,
    serverAuth: auth,
  })
  const server = await createNodeManagedOpencodeServer({
    hostname: options.hostname || '127.0.0.1',
    port: options.port ?? 0,
    timeout: options.timeout ?? 5000,
    config: options.config,
    env,
    cwd: options.paths.getRuntimeHomeDir(),
    logLevel: options.logLevel,
    opencodeBinPath: options.opencodeBinPath,
    onUnexpectedExit: options.onUnexpectedExit,
  })
  const client = createOpencodeClient(buildNodeOpencodeCloudRuntimeClientConfig(server.url, auth))
  const adapter = createSdkCloudRuntimeAdapter(client)
  return {
    ...adapter,
    url: server.url,
    auth,
    subscribeEvents(listener, subscribeOptions) {
      return subscribeToOpencodeCloudRuntimeEvents(client, listener, subscribeOptions)
    },
    close() {
      server.close()
    },
  }
}
