import { sanitizeForExport } from './log-sanitizer.js'

export const RUNTIME_EVENT_MAX_DEPTH = 12
export const RUNTIME_EVENT_MAX_NODES = 2_048
export const RUNTIME_EVENT_MAX_COLLECTION_ENTRIES = 256
export const RUNTIME_EVENT_MAX_STRING_BYTES = 64 * 1_024
export const RUNTIME_EVENT_MAX_SERIALIZED_BYTES = 512 * 1_024

export const RUNTIME_EVENT_REDACTED = '[REDACTED_RUNTIME_VALUE]'
export const RUNTIME_EVENT_TRUNCATED = '[TRUNCATED_RUNTIME_VALUE]'

const SENSITIVE_RUNTIME_KEY = /(?:authorization|cookie|credential|password|passwd|private[_-]?key|secret|signature|token|api[_-]?key)/i
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const FILE_URL_PATTERN = /\bfile:\/\/[^\s"'`<>]+/gi
const URI_USERINFO_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi
const WINDOWS_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`=])(?:[a-z]:[\\/]|\\\\)[^\s"'`<>]*/gi
const COMMON_POSIX_ABSOLUTE_PATH_PATTERN = /(?:^|[\s("'`=])\/(?:Users|home|Volumes|Library|usr|tmp|private|var|opt|etc|workspace|workspaces|root|mnt|srv|app|data)(?:\/[^\s"'`<>]*)?/g

type RuntimeEventSanitizerOptions = {
  managedPaths?: unknown
  /**
   * Disable diagnostics-style secret/path rewriting for intentional product
   * content such as prompts and assistant messages. Structural bounds remain
   * active. Defaults to true for opaque runtime/tool payloads.
   */
  redactSensitive?: boolean
}

type SanitizerState = {
  nodes: number
  seen: WeakSet<object>
  managedPaths: string[]
  redactSensitive: boolean
}

function utf8ByteLength(value: string) {
  const TextEncoderCtor = (globalThis as {
    TextEncoder: new () => { encode: (input: string) => { byteLength: number } }
  }).TextEncoder
  return new TextEncoderCtor().encode(value).byteLength
}

function truncateUtf8(value: string, maxBytes: number) {
  if (utf8ByteLength(value) <= maxBytes) return value
  let output = ''
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) || 0
    const size = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + size > maxBytes) break
    output += character
    bytes += size
  }
  return `${output}${RUNTIME_EVENT_TRUNCATED}`
}

function normalizeManagedPaths(value: unknown) {
  if (!Array.isArray(value)) return []
  const paths: string[] = []
  for (const candidate of value.slice(0, 64)) {
    if (typeof candidate !== 'string') continue
    const path = candidate.trim().slice(0, 4_096)
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

function redactRuntimeString(value: string, managedPaths: readonly string[], redactSensitive: boolean) {
  if (!redactSensitive) return truncateUtf8(value, RUNTIME_EVENT_MAX_STRING_BYTES)
  let sanitized = sanitizeForExport(value)
  for (const managedPath of managedPaths) {
    sanitized = sanitized.replaceAll(managedPath, '[REDACTED_MANAGED_PATH]')
  }
  sanitized = sanitized
    .replace(URI_USERINFO_PATTERN, '$1[REDACTED_USERINFO]@')
    .replace(FILE_URL_PATTERN, '[REDACTED_LOCAL_FILE_URL]')
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, (match) => `${/^[\s("'`=]/.test(match) ? match[0] : ''}[REDACTED_LOCAL_PATH]`)
    .replace(COMMON_POSIX_ABSOLUTE_PATH_PATTERN, (match) => `${/^[\s("'`=]/.test(match) ? match[0] : ''}[REDACTED_LOCAL_PATH]`)
  return truncateUtf8(sanitized, RUNTIME_EVENT_MAX_STRING_BYTES)
}

function sanitizeEntry(value: unknown, depth: number, state: SanitizerState): unknown {
  state.nodes += 1
  if (state.nodes > RUNTIME_EVENT_MAX_NODES || depth > RUNTIME_EVENT_MAX_DEPTH) {
    return RUNTIME_EVENT_TRUNCATED
  }

  if (typeof value === 'string') return redactRuntimeString(value, state.managedPaths, state.redactSensitive)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean' || value === null) return value
  if (typeof value === 'bigint') return value.toString()
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()

  if (typeof value !== 'object') return String(value)
  if (state.redactSensitive && !Array.isArray(value) && (value as Record<string, unknown>).type === 'file') return undefined
  if (state.seen.has(value)) return RUNTIME_EVENT_TRUNCATED
  state.seen.add(value)
  try {
    if (Array.isArray(value)) {
      const output: unknown[] = []
      const entries = value.slice(0, RUNTIME_EVENT_MAX_COLLECTION_ENTRIES)
      for (const entry of entries) {
        const sanitized = sanitizeEntry(entry, depth + 1, state)
        if (sanitized !== undefined) output.push(sanitized)
      }
      if (value.length > entries.length) output.push(RUNTIME_EVENT_TRUNCATED)
      return output
    }

    const output: Record<string, unknown> = {}
    let examined = 0
    const record = value as Record<string, unknown>
    // Do not use Object.entries/Object.keys here: both materialize every key
    // before the collection limit can take effect. Runtime/tool payloads are
    // untrusted and can contain extremely wide objects.
    for (const rawKey in record) {
      if (!Object.prototype.hasOwnProperty.call(record, rawKey)) continue
      examined += 1
      if (examined > RUNTIME_EVENT_MAX_COLLECTION_ENTRIES) {
        output.truncated = RUNTIME_EVENT_TRUNCATED
        break
      }
      const key = truncateUtf8(redactRuntimeString(rawKey, state.managedPaths, state.redactSensitive), 256)
      if (!key || UNSAFE_OBJECT_KEYS.has(key)) continue
      // Sanitizing keys as well as values prevents paths, URI credentials, or
      // token-shaped material hidden in property names from crossing the
      // durable boundary. Preserve all entries if redaction collapses two raw
      // keys to the same safe spelling.
      let safeKey = key
      let collision = 1
      while (Object.prototype.hasOwnProperty.call(output, safeKey)) {
        collision += 1
        safeKey = truncateUtf8(`${key}#${collision}`, 256)
      }
      let entry: unknown
      try {
        entry = record[rawKey]
      } catch {
        entry = RUNTIME_EVENT_TRUNCATED
      }
      output[safeKey] = state.redactSensitive && SENSITIVE_RUNTIME_KEY.test(rawKey)
        ? RUNTIME_EVENT_REDACTED
        : sanitizeEntry(entry, depth + 1, state)
      if (output[safeKey] === undefined) delete output[safeKey]
    }
    return output
  } finally {
    state.seen.delete(value)
  }
}

function serializedByteLength(value: unknown) {
  try {
    return utf8ByteLength(JSON.stringify(value))
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

/**
 * Sanitizes runtime-owned event data before it crosses a durable or remote
 * boundary. The walker is deliberately lossy: secrets, local paths, cycles,
 * excessive depth/cardinality, and oversized strings are replaced explicitly.
 */
export function sanitizeRuntimeEventValue(
  value: unknown,
  options: RuntimeEventSanitizerOptions = {},
): unknown {
  const sanitized = sanitizeEntry(value, 0, {
    nodes: 0,
    seen: new WeakSet<object>(),
    managedPaths: normalizeManagedPaths(options.managedPaths),
    redactSensitive: options.redactSensitive !== false,
  })
  return serializedByteLength(sanitized) <= RUNTIME_EVENT_MAX_SERIALIZED_BYTES
    ? sanitized
    : RUNTIME_EVENT_TRUNCATED
}

export function sanitizeRuntimeEventRecord(
  value: unknown,
  options: RuntimeEventSanitizerOptions = {},
): Record<string, unknown> {
  const sanitized = sanitizeRuntimeEventValue(value, options)
  if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
    return sanitized as Record<string, unknown>
  }
  return sanitized === RUNTIME_EVENT_TRUNCATED
    ? { truncated: RUNTIME_EVENT_TRUNCATED }
    : {}
}
