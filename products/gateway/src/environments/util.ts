/**
 * Shared environment primitives and redaction (JOE-936 / JOE-919).
 * Leaf module — no import from environments.ts.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

export const DEFAULT_ENVIRONMENT_NAME = 'local-process'
export const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
export const DEFAULT_TTL_MS = 60 * 60 * 1000
export const DEFAULT_CONTAINER_WORKDIR = '/workspace'
export const SECRET_NAME_PATTERN = /(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i
export const SENSITIVE_TEXT_FIELD_PATTERN = /(?:ERROR|REASON|MESSAGE|OUTPUT|STDERR|STDOUT|LOG|EVIDENCE|PAYLOAD)/i
export const REMOTE_HOST_PROCESS_CONTROL_ENV_PATTERN = /^(?:PATH|HOME|SHELL|TMPDIR|TEMP|TMP|USER|LOGNAME|BASH_ENV|ENV|ZDOTDIR|IFS|CDPATH|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|ELECTRON_RUN_AS_NODE|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|PYTHONHOME|PYTHONPATH|PYTHONSTARTUP|PYTHONINSPECT|PYTHONWARNINGS|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|GCONV_PATH|GLIBC_TUNABLES|OPENSSL_CONF|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|HOSTALIASES|RES_OPTIONS|LOCALDOMAIN|GIT_SSH|GIT_SSH_COMMAND|SSH_AUTH_SOCK|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_CONFIG|DOCKER_CONFIG|KUBECONFIG|XDG_.+|LD_.+|DYLD_.+|CRABBOX_.+)$/
export const SECRET_VALUE_PLACEHOLDER = '<secret-from-environment>'
export const MAX_ENVIRONMENT_IDEMPOTENCY_KEY_LENGTH = 512

export function redactEnvironmentRecord<T>(value: T): T {
  return redact(value) as T
}

export function redactEnvironmentSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s'",)]+/gi, '<url:redacted>')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization|bearer|webhook|chat[_ -]?id|phone)\s*[:=]\s*[^\s'",)]+/gi, '$1=<redacted>')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'",)]+/g, match => {
      if (/^https?:\/\//i.test(match)) return match
      return `<path:${hashText(path.resolve(match)).slice(0, 12)}>`
    })
}

export function redactEnvironmentNetworkTarget(value: string): string {
  const target = String(value || '').trim()
  if (!target) return ''
  try {
    const parsed = new URL(target)
    if (parsed.protocol && parsed.host) return `${parsed.protocol}//${parsed.host.toLowerCase()}`
  } catch {
    // Hostname, wildcard, and scp-like allow entries are not always valid URLs.
  }
  const withoutUserInfo = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target
  const head = withoutUserInfo.split(/[/?#]/)[0]!
  if (/^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(head)) return head.toLowerCase()
  if (/^(\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/i.test(head)) return head.toLowerCase()
  const scpLikeHost = head.match(/^([a-z0-9.-]+):[^:]+$/i)?.[1]
  if (scpLikeHost) return scpLikeHost.toLowerCase()
  const redacted = redactEnvironmentSensitiveText(head)
  return redacted === head ? `<network-target:${hashText(target).slice(0, 12)}>` : redacted
}

export function redactEnvironmentNetworkTargets(values: string[]): string[] {
  return uniqueStrings(values.map(redactEnvironmentNetworkTarget)).sort()
}


export function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 80) || 'item'
}

export function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function normalizeEnvironmentIdempotencyKey(value: string): string {
  const key = String(value || '').trim()
  if (!key || key.length > MAX_ENVIRONMENT_IDEMPOTENCY_KEY_LENGTH || /[\0\r\n]/.test(key)) {
    throw new Error(`environment acquisition idempotency key must be 1-${MAX_ENVIRONMENT_IDEMPOTENCY_KEY_LENGTH} printable characters`)
  }
  return key
}

export function environmentIdempotencyKeyHash(value: string): string {
  return hashText(normalizeEnvironmentIdempotencyKey(value)).slice(0, 24)
}

export function remoteCrabboxAcquisitionSlug(idempotencyKey: string): string {
  return `ogw-${hashText(normalizeEnvironmentIdempotencyKey(idempotencyKey)).slice(0, 32)}`
}

export function uniqueStrings(values: unknown[]): string[] {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))].sort()
}

export function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return number
}

export function boundedNumber(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} must be a number between ${min} and ${max}`)
  return number
}

export function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('environment text field must be a string')
  const text = value.trim()
  return text ? text.substring(0, maxLength) : undefined
}

export function normalizeRuntimeExecutable(value: unknown, label: string): string | undefined {
  const text = optionalText(value, 1024)
  if (!text) return undefined
  if (text.includes('\0') || /[\r\n]/.test(text)) throw new Error(`${label} must be one executable path or command name`)
  return text
}

export function shortText(value: unknown, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().substring(0, maxLength)
}

export function durationMs(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') return boundedInteger(value, 1000, 30 * 24 * 60 * 60 * 1000, 'duration')
  const match = String(value).trim().match(/^(\d+)(ms|s|m|h|d)$/i)
  if (!match) throw new Error(`duration must use ms, s, m, h, or d suffix: ${String(value)}`)
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return boundedInteger(amount * multiplier, 1000, 30 * 24 * 60 * 60 * 1000, 'duration')
}


export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_NAME_PATTERN.test(key)) out[key] = '<redacted>'
    else if (SENSITIVE_TEXT_FIELD_PATTERN.test(key)) out[key] = redactSensitiveValue(val)
    else out[key] = redact(val)
  }
  return out
}

export function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEnvironmentSensitiveText(value)
  if (Array.isArray(value)) return value.map(redactSensitiveValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_NAME_PATTERN.test(key) ? '<redacted>' : redactSensitiveValue(val)
  }
  return out
}

export function binaryAvailable(binary: string): boolean {
  if (path.isAbsolute(binary)) {
    try {
      fs.accessSync(binary, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const paths = (process.env['PATH'] || '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  return paths.some(dir => extensions.some(ext => {
    try {
      fs.accessSync(path.join(dir, binary + ext), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }))
}
