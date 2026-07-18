import * as fs from 'node:fs'
import { getConfig, getConfigPath } from '../config.js'
import { localHttpAdminTokenFilePath } from '../security.js'
import type { ServiceHealthComponent, ServiceHealthReport } from '../service-health.js'
import type { ActiveRunControlResult } from '../work-store.js'

/**
 * Resolve an admin-capable daemon bearer token from the same env vars the
 * daemon accepts (see configuredHttpTokens in src/security.ts). The CLI issues
 * admin-tier operations (status, shutdown, config, task), so it reads direct
 * admin tokens first and then token-file references.
 */
export function resolveCliDaemonToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = String(env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN'] || '').trim()
  if (direct) return direct
  const fromFile = readTokenFile(env['OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN_FILE'])
  if (fromFile) return fromFile
  return undefined
}

function readTokenFile(filePath: string | undefined): string | undefined {
  const target = String(filePath || '').trim()
  if (!target) return undefined
  try {
    return fs.readFileSync(target, 'utf-8').trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * Build the daemon Authorization header for a resolved token. Returns an empty
 * object when the token is absent so the default loopback path stays
 * header-free. Pure + exported for unit testing.
 */
export function buildGatewayAuthHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

let cliDaemonTokenResolved = false
let cliDaemonTokenValue: string | undefined
let capabilityLoopbackWarned = false
const CLI_DAEMON_REQUEST_TIMEOUT_MS = 5000
export const CLI_DAEMON_RESPONSE_LIMIT_BYTES = 1024 * 1024

export class GatewayTransportError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options)
    this.name = 'GatewayTransportError'
  }
}

export function isGatewayTransportError(error: unknown): error is GatewayTransportError {
  return error instanceof GatewayTransportError
}

/** Resolve the CLI daemon token once per process. */
function cliDaemonToken(): string | undefined {
  if (!cliDaemonTokenResolved) {
    cliDaemonTokenValue = resolveCliDaemonToken() || readTokenFile(localHttpAdminTokenFilePath())
    cliDaemonTokenResolved = true
  }
  return cliDaemonTokenValue
}

/**
 * When `security.capabilityScopedLoopback` is enabled the daemon stops
 * auto-trusting loopback, so a token-less CLI request returns a bare 403. Warn
 * the operator once with a concrete recovery path instead of leaving them
 * staring at the 403 with no way back (config edits are admin-gated too).
 */
function warnIfCapabilityLoopbackWithoutToken(): void {
  if (capabilityLoopbackWarned || cliDaemonToken()) return
  let enabled = false
  try { enabled = getConfig().security.capabilityScopedLoopback === true } catch { enabled = false }
  if (!enabled) return
  capabilityLoopbackWarned = true
  console.error('opencode-gateway: security.capabilityScopedLoopback is enabled but no CLI daemon token is set — daemon requests will be rejected (403).')
  console.error(`  Run opencode-gateway install to create ${localHttpAdminTokenFilePath()}, set OPENCODE_GATEWAY_HTTP_ADMIN_TOKEN, or set security.capabilityScopedLoopback=false to restore loopback trust.`)
}

/**
 * Single entry point for every CLI→daemon HTTP call. Attaches the capability
 * token as a bearer header when one is resolvable (no-op by default) and warns
 * once if the capability-scoped-loopback toggle is on without a token.
 */
export async function gatewayFetch(pathname: string, init: RequestInit = {}): Promise<Response> {
  const config = getConfig()
  const token = cliDaemonToken()
  const headers = { ...(init.headers as Record<string, string> | undefined), ...buildGatewayAuthHeaders(token) }
  const controller = new AbortController()
  let deadlineExceeded = false
  const timeout = setTimeout(() => {
    deadlineExceeded = true
    controller.abort()
  }, CLI_DAEMON_REQUEST_TIMEOUT_MS)
  timeout.unref?.()
  const externalSignal = init.signal
  const relayExternalAbort = () => controller.abort(externalSignal?.reason)
  if (externalSignal?.aborted) relayExternalAbort()
  else externalSignal?.addEventListener('abort', relayExternalAbort, { once: true })
  try {
    const response = await fetch(`http://127.0.0.1:${config.httpPort}${pathname}`, {
      ...init,
      headers,
      signal: controller.signal,
    })
    const buffered = await bufferGatewayResponse(response)
    if (buffered.status === 403 && !token) warnIfCapabilityLoopbackWithoutToken()
    return buffered
  } catch (err: any) {
    if (err instanceof GatewayTransportError) throw err
    if (err?.name === 'AbortError' && deadlineExceeded) {
      throw new GatewayTransportError(`Gateway daemon request timed out after ${CLI_DAEMON_REQUEST_TIMEOUT_MS}ms: ${pathname}`, { cause: err })
    }
    throw new GatewayTransportError(`Gateway daemon transport failed for ${pathname}: ${err?.message || err}`, { cause: err })
  } finally {
    clearTimeout(timeout)
    externalSignal?.removeEventListener('abort', relayExternalAbort)
  }
}

export async function bufferGatewayResponse(response: Response, maxBytes = CLI_DAEMON_RESPONSE_LIMIT_BYTES): Promise<Response> {
  const bytes = await readGatewayResponseBytesBounded(response, maxBytes)
  const text = bytes.toString('utf8')
  let parsed: unknown
  let parseError: unknown
  try { parsed = JSON.parse(text) } catch (err) { parseError = err }

  const bodyAllowed = ![204, 205, 304].includes(response.status)
  const buffered = new Response(bodyAllowed ? bytes : null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
  Object.defineProperty(buffered, 'json', {
    configurable: true,
    value: async () => {
      if (parseError) throw parseError
      return parsed
    },
  })
  return buffered
}

async function readGatewayResponseBytesBounded(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new GatewayTransportError(`Gateway daemon response exceeds ${maxBytes} bytes`)
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      bytes += value.byteLength
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new GatewayTransportError(`Gateway daemon response exceeds ${maxBytes} bytes`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, bytes)
}

export class GatewayHttpError extends Error {
  constructor(readonly status: number, readonly payload: any, message: string) {
    super(message)
    this.name = 'GatewayHttpError'
  }
}

export async function postGatewayJson(pathname: string, body: unknown): Promise<any> {
  const res = await gatewayFetch(pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await res.json().catch(() => ({})) as any
  if (!res.ok) throw new GatewayHttpError(res.status, payload, payload?.error || `HTTP ${res.status}`)
  return payload
}

export async function patchGatewayJson(pathname: string, body: unknown): Promise<any> {
  const res = await gatewayFetch(pathname, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const payload = await res.json().catch(() => ({})) as any
  if (!res.ok) throw new GatewayHttpError(res.status, payload, payload?.error || `HTTP ${res.status}`)
  return payload
}

export async function fetchGatewayJson(pathname: string): Promise<any> {
  const res = await gatewayFetch(pathname)
  const payload = await res.json().catch(() => ({})) as any
  if (!res.ok) throw new GatewayHttpError(res.status, payload, payload?.error || `HTTP ${res.status}`)
  return payload
}

export function hasArg(name: string): boolean {
  return process.argv.includes(name)
}

export function cliUsageError(...lines: string[]): void {
  for (const line of lines) console.error(line)
  process.exitCode = 2
}

export function assertConfigured(command: string): void {
  if (fs.existsSync(getConfigPath())) return
  console.error(`Gateway config is missing: ${getConfigPath()}`)
  console.error(`Run \`opencode-gateway setup\` before \`opencode-gateway ${command}\`.`)
  process.exit(1)
}

export function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : undefined
  return value && !value.startsWith('--') ? value : undefined
}

export function allArgValues(name: string): string[] {
  const values: string[] = []
  for (let i = 0; i < process.argv.length; i++) {
    const next = process.argv[i + 1]
    if (process.argv[i] === name && next && !next.startsWith('--')) values.push(next)
  }
  return values
}

export function formatServiceHealthText(report: ServiceHealthReport): string {
  const lines = [
    `Gateway health: ${report.status}`,
    report.summary,
    '',
    ...report.components.map(formatServiceHealthComponent),
  ]
  if (report.attention.length) {
    lines.push('', 'Remediation:')
    for (const row of report.attention) lines.push(`- ${row.label}: ${row.remediation}`)
  }
  if (report.deferred?.length) {
    lines.push('', 'Deferred / non-blocking:')
    for (const row of report.deferred) lines.push(`- ${row.label}: ${row.remediation}`)
  }
  return lines.join('\n')
}

function formatServiceHealthComponent(row: ServiceHealthComponent): string {
  const detail = row.detail ? ` (${row.detail})` : ''
  return `- ${row.label}: ${row.status} - ${row.summary}${detail}`
}

export function normalizeServiceHealthReport(input: any): ServiceHealthReport {
  const componentCounts = input?.serviceCounts || input?.counts
  const components = Array.isArray(input?.components) ? input.components : []
  const attention = Array.isArray(input?.attention) ? input.attention : components.filter((row: any) => row?.status !== 'ok' && row?.releaseBlocking !== false)
  const deferred = Array.isArray(input?.deferred) ? input.deferred : components.filter((row: any) => row?.status !== 'ok' && row?.releaseBlocking === false)
  return {
    ...input,
    components,
    attention,
    deferred,
    counts: {
      ok: Number(componentCounts?.ok || 0),
      degraded: Number(componentCounts?.degraded || 0),
      down: Number(componentCounts?.down || 0),
    },
    releaseBlockingCounts: {
      ok: Number(input?.releaseBlockingCounts?.ok || 0),
      degraded: Number(input?.releaseBlockingCounts?.degraded || 0),
      down: Number(input?.releaseBlockingCounts?.down || 0),
    },
  } as ServiceHealthReport
}

export async function openUrl(url: string): Promise<void> {
  if (process.platform !== 'darwin') {
    console.log(`Open: ${url}`)
    return
  }
  const { spawn } = await import('node:child_process')
  const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  child.unref()
}

export function formatObservabilityStatusLine(trace: any, slo: any[]): string {
  const pass = slo.filter(row => row?.status === 'pass').length
  const warn = slo.filter(row => row?.status === 'warn').length
  const fail = slo.filter(row => row?.status === 'fail').length
  const status = fail ? 'fail' : warn ? 'warn' : 'pass'
  return `Trace: ${trace?.traceRootId || 'trace_unavailable'} | SLO: ${status} (${pass} pass, ${warn} warn, ${fail} fail)`
}

export function formatActiveRunControlCliText(control: ActiveRunControlResult): string {
  return [
    `Run control: ${control.action}`,
    `Outcome: ${control.outcome}`,
    `Reason: ${control.reason}`,
    control.task?.id ? `Issue: ${control.task.title || control.task.id} (${control.task.id})` : '',
    control.run?.id ? `Run: ${control.run.id}` : '',
    control.restartBehavior ? `Restart behavior: ${control.restartBehavior}` : '',
    control.abortedSessionId ? `Aborted OpenCode session: ${control.abortedSessionId}` : '',
    `Next: ${control.nextAction}`,
  ].filter(Boolean).join('\n')
}

export function firstEvidenceOutputArg(): string | undefined {
  const args = process.argv.slice(4)
  const valueFlags = new Set([
    '--task',
    '--run',
    '--session',
    '--roadmap',
    '--project',
    '--alert',
    '--limit',
    '--redact',
    '--provider',
    '--mode',
    '--state',
    '--operator-action',
    '--action',
    '--output',
  ])
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (valueFlags.has(arg)) { i++; continue }
    if (arg.startsWith('--')) continue
    return arg
  }
  return undefined
}
