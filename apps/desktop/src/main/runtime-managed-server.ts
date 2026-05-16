import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

export const MANAGED_OPENCODE_SERVER_USERNAME = 'opencode'

export type ManagedOpencodeServerAuth = {
  username: string
  password: string
  authorizationHeader: string
}

export type ManagedOpencodeServerLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

const MANAGED_OPENCODE_SERVER_LOG_LEVELS = new Set<ManagedOpencodeServerLogLevel>([
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
])

function normalizeManagedOpencodeServerLogLevel(value: unknown): ManagedOpencodeServerLogLevel | null {
  if (typeof value !== 'string') return null
  const normalized = value.toUpperCase()
  if (!MANAGED_OPENCODE_SERVER_LOG_LEVELS.has(normalized as ManagedOpencodeServerLogLevel)) return null
  return normalized as ManagedOpencodeServerLogLevel
}

export function buildManagedOpencodeAuthorizationHeader(input: { username: string; password: string }) {
  return `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}`
}

export function createManagedOpencodeServerAuth(): ManagedOpencodeServerAuth {
  const password = randomBytes(32).toString('base64url')
  return {
    username: MANAGED_OPENCODE_SERVER_USERNAME,
    password,
    authorizationHeader: buildManagedOpencodeAuthorizationHeader({
      username: MANAGED_OPENCODE_SERVER_USERNAME,
      password,
    }),
  }
}

export function buildManagedOpencodeServerEnvironment(
  env: NodeJS.ProcessEnv,
  config?: OpencodeServerOptions['config'],
) {
  const next = { ...env }
  if (config !== undefined) {
    next.OPENCODE_CONFIG_CONTENT = JSON.stringify(config ?? {})
  } else {
    delete next.OPENCODE_CONFIG_CONTENT
  }
  return next
}

export function resolveManagedOpencodeCommand(opencodeBinPath?: string | null) {
  const explicitBinary = opencodeBinPath?.trim()
  return explicitBinary || 'opencode'
}

export function resolveManagedOpencodeSpawn(
  env: NodeJS.ProcessEnv,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  opencodeBinPath?: string | null,
) {
  const explicitBinary = resolveManagedOpencodeCommand(opencodeBinPath)
  if (explicitBinary !== 'opencode') return { command: explicitBinary, args }
  if (platform === 'win32') {
    return {
      command: env.ComSpec?.trim() || env.COMSPEC?.trim() || 'cmd.exe',
      args: ['/d', '/s', '/c', 'opencode', ...args],
    }
  }
  return { command: 'opencode', args }
}

const OPENCODE_SERVER_LISTENING_PREFIX = 'opencode server listening'

export interface ManagedOpencodeServerStdoutParseResult {
  buffer: string
  url?: string
  error?: string
}

function extractManagedOpencodeServerUrl(line: string) {
  if (!line.startsWith(OPENCODE_SERVER_LISTENING_PREFIX)) return null
  return line.match(/on\s+(https?:\/\/[^\s]+)/)?.[1] || null
}

export function parseManagedOpencodeServerStdoutChunk(
  buffer: string,
  chunk: string,
): ManagedOpencodeServerStdoutParseResult {
  const text = buffer + chunk
  const lines = text.split('\n')
  const nextBuffer = lines.pop() ?? ''

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    const url = extractManagedOpencodeServerUrl(line)
    if (url) return { buffer: nextBuffer, url }
    if (line.startsWith(OPENCODE_SERVER_LISTENING_PREFIX)) {
      return { buffer: nextBuffer, error: `Failed to parse server url from output: ${line}` }
    }
  }

  return { buffer: nextBuffer }
}

function stopManagedOpencodeProcess(proc: ChildProcess) {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  if (process.platform === 'win32' && proc.pid) {
    const out = spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true })
    if (!out.error && out.status === 0) return
  }
  proc.kill()
}

export interface ManagedProcessOutputStreams {
  stdout?: { resume(): unknown } | null
  stderr?: { resume(): unknown } | null
}

export function drainManagedOpencodeProcessOutput(proc: ManagedProcessOutputStreams) {
  // Startup parsing stops once the server URL is known, but the child
  // keeps its stdout/stderr pipes. Keep draining them without retaining
  // logs so noisy runtime output cannot fill the pipe buffer.
  proc.stdout?.resume()
  proc.stderr?.resume()
}

function bindManagedOpencodeAbort(proc: ChildProcess, signal?: AbortSignal, onAbort?: () => void) {
  if (!signal) return () => undefined
  const clear = () => {
    signal.removeEventListener('abort', abort)
    proc.off('exit', clear)
    proc.off('error', clear)
  }
  const abort = () => {
    clear()
    stopManagedOpencodeProcess(proc)
    onAbort?.()
  }

  signal.addEventListener('abort', abort, { once: true })
  proc.on('exit', clear)
  proc.on('error', clear)
  if (signal.aborted) abort()
  return clear
}

export async function createManagedOpencodeServer(options: OpencodeServerOptions & {
  env: NodeJS.ProcessEnv
  opencodeBinPath?: string | null
  logLevel?: ManagedOpencodeServerLogLevel
  cwd?: string
}) {
  const resolved = {
    hostname: '127.0.0.1',
    port: 4096,
    timeout: 5000,
    ...options,
  }
  const args = ['serve', `--hostname=${resolved.hostname}`, `--port=${resolved.port}`]
  const logLevel = normalizeManagedOpencodeServerLogLevel(resolved.logLevel)
    || normalizeManagedOpencodeServerLogLevel((resolved.config as { logLevel?: unknown } | undefined)?.logLevel)
  if (logLevel) args.push(`--log-level=${logLevel}`)

  const spawnPlan = resolveManagedOpencodeSpawn(resolved.env, args, process.platform, resolved.opencodeBinPath)
  const proc = spawn(spawnPlan.command, spawnPlan.args, {
    env: buildManagedOpencodeServerEnvironment(resolved.env, resolved.config),
    cwd: resolved.cwd,
    windowsHide: true,
  })

  let clear: () => void = () => undefined
  const url = await new Promise<string>((resolveUrl, reject) => {
    let output = ''
    let stdoutBuffer = ''
    let startupSettled = false

    function cleanupStartupListeners() {
      proc.stdout?.off('data', onStdoutData)
      proc.stderr?.off('data', onStderrData)
      proc.off('exit', onExit)
      proc.off('error', onError)
    }

    function settleStartup(callback: () => void) {
      if (startupSettled) return
      startupSettled = true
      clearTimeout(id)
      cleanupStartupListeners()
      callback()
    }

    function rejectStartup(error: Error, stopProcess = false) {
      settleStartup(() => reject(error))
      clear()
      if (stopProcess) stopManagedOpencodeProcess(proc)
    }

    const id = setTimeout(() => {
      rejectStartup(new Error(`Timeout waiting for server to start after ${resolved.timeout}ms`), true)
    }, resolved.timeout)

    function onStdoutData(chunk: Buffer) {
      if (startupSettled) return
      const text = chunk.toString()
      output += text
      const parsed = parseManagedOpencodeServerStdoutChunk(stdoutBuffer, text)
      stdoutBuffer = parsed.buffer
      if (parsed.error) {
        rejectStartup(new Error(parsed.error), true)
        return
      }
      if (parsed.url) {
        const startupUrl = parsed.url
        settleStartup(() => {
          drainManagedOpencodeProcessOutput(proc)
          resolveUrl(startupUrl)
        })
      }
    }

    function onStderrData(chunk: Buffer) {
      if (startupSettled) return
      output += chunk.toString()
    }

    function onExit(code: number | null) {
      let message = `Server exited with code ${code}`
      if (output.trim()) message += `\nServer output: ${output}`
      rejectStartup(new Error(message))
    }

    function onError(error: Error) {
      rejectStartup(error)
    }

    proc.stdout?.on('data', onStdoutData)
    proc.stderr?.on('data', onStderrData)
    proc.on('exit', onExit)
    proc.on('error', onError)

    clear = bindManagedOpencodeAbort(proc, resolved.signal, () => {
      settleStartup(() => reject(resolved.signal?.reason))
    })
  })

  return {
    url,
    close() {
      clear()
      stopManagedOpencodeProcess(proc)
    },
  }
}
