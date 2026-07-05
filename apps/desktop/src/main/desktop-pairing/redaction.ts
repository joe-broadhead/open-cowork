import type { RuntimeSessionEvent } from '@open-cowork/runtime-host/session-event-dispatcher'
import type {
  DesktopPairingPolicy,
  DesktopPairingRemoteEvent,
  SessionInfo,
} from '@open-cowork/shared'
const MAX_STRING_BYTES = 16 * 1024
const MAX_ARRAY_ITEMS = 50
const MAX_OBJECT_KEYS = 100

const POSIX_ABSOLUTE_PATH_RE = /(^|[\s"'`([{<])\/(?:Users|home|private|var|tmp|Volumes)\/[^\s"'`)\]}>,]+/g
const WINDOWS_ABSOLUTE_PATH_RE = /\b[A-Za-z]:\\[^\s"'`)\]}>,]+/g
const FILE_URL_RE = /\bfile:\/\/[^\s"'`)\]}>,]+/g
const MCP_DETAIL_KEYS = new Set([
  'command',
  'args',
  'env',
  'cwd',
  'stdio',
  'process',
  'pid',
  'serverPath',
])
const SECRETISH_KEYS_RE = /(token|secret|password|credential|api[_-]?key|authorization|cookie|refresh)/i

function byteLength(value: string) {
  return Buffer.byteLength(value, 'utf8')
}

function truncateString(value: string) {
  if (byteLength(value) <= MAX_STRING_BYTES) return value
  return `${Buffer.from(value).subarray(0, MAX_STRING_BYTES).toString('utf8')}...[truncated]`
}

export function redactDesktopPairingText(value: string, policy: DesktopPairingPolicy) {
  let next = truncateString(value)
  if (!policy.exposeLocalPaths) {
    next = next
      .replace(POSIX_ABSOLUTE_PATH_RE, (match, prefix: string) => `${prefix}[local-path]`)
      .replace(WINDOWS_ABSOLUTE_PATH_RE, '[local-path]')
      .replace(FILE_URL_RE, '[local-file-url]')
  }
  return next
}

export function redactDesktopPairingValue(value: unknown, policy: DesktopPairingPolicy, depth = 0): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return redactDesktopPairingText(value, policy)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => redactDesktopPairingValue(entry, policy, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more item(s) redacted]`)
    return items
  }
  if (typeof value !== 'object') return '[unsupported]'
  if (depth > 6) return '[redacted-depth]'

  const output: Record<string, unknown> = {}
  let count = 0
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (++count > MAX_OBJECT_KEYS) {
      output.__redacted = `${Object.keys(value as Record<string, unknown>).length - MAX_OBJECT_KEYS} more key(s)`
      break
    }
    if (SECRETISH_KEYS_RE.test(key)) {
      output[key] = '[secret-redacted]'
      continue
    }
    if (!policy.exposeLocalMcpDetails && MCP_DETAIL_KEYS.has(key)) {
      output[key] = '[local-mcp-detail-redacted]'
      continue
    }
    if (!policy.exposeArtifactBodies && (key === 'body' || key === 'contentBase64' || key === 'dataBase64')) {
      output[key] = '[artifact-body-redacted]'
      continue
    }
    output[key] = redactDesktopPairingValue(entry, policy, depth + 1)
  }
  return output
}

export function redactDesktopPairingSessionInfo(session: SessionInfo, policy: DesktopPairingPolicy): SessionInfo {
  return {
    ...session,
    title: session.title ? redactDesktopPairingText(session.title, policy) : session.title,
    directory: policy.exposeLocalPaths && session.directory
      ? redactDesktopPairingText(session.directory, policy)
      : null,
  }
}

export function runtimeEventToDesktopPairingRemoteEvent(input: {
  pairingId: string
  eventId: string
  event: RuntimeSessionEvent
  policy: DesktopPairingPolicy
  occurredAt: string
}): DesktopPairingRemoteEvent | null {
  const { pairingId, eventId, event, policy, occurredAt } = input
  if (!event.sessionId) return null
  if (event.workspaceId && event.workspaceId !== 'local') return null
  const payload = redactDesktopPairingValue({
    type: event.type,
    data: event.data,
  }, policy)
  return {
    id: eventId,
    pairingId,
    type: 'session.event',
    workspaceId: 'local',
    sessionId: event.sessionId,
    occurredAt,
    payload: payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : { value: payload },
  }
}
