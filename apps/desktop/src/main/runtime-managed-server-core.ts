import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { randomBytes } from 'node:crypto'
import {
  type ManagedOpencodeServerParentMessage,
  type ManagedOpencodeServerSupervisorMessage,
} from './runtime-managed-server-protocol.ts'

export const MANAGED_OPENCODE_SERVER_USERNAME = 'opencode'

export type ManagedOpencodeServerAuth = {
  username: string
  password: string
  authorizationHeader: string
}

export type ManagedOpencodeServerLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export type ManagedOpencodeServerUnexpectedExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type ManagedOpencodeSupervisorProcess = {
  pid?: number
  stdout?: { resume(): unknown } | null
  stderr?: { resume(): unknown } | null
  postMessage(message: ManagedOpencodeServerParentMessage): void
  kill(): boolean
  on(event: 'message', listener: (message: ManagedOpencodeServerSupervisorMessage) => void): unknown
  on(event: 'spawn', listener: () => void): unknown
  on(event: 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown
  on(event: 'error', listener: (...args: unknown[]) => void): unknown
  off(event: 'message', listener: (message: ManagedOpencodeServerSupervisorMessage) => void): unknown
  off(event: 'spawn', listener: () => void): unknown
  off(event: 'exit', listener: (code: number | null, signal?: NodeJS.Signals | null) => void): unknown
  off(event: 'error', listener: (...args: unknown[]) => void): unknown
}

export type ManagedOpencodeSupervisorFork = (modulePath: string) => ManagedOpencodeSupervisorProcess

const MANAGED_OPENCODE_SERVER_LOG_LEVELS = new Set<ManagedOpencodeServerLogLevel>([
  'DEBUG',
  'INFO',
  'WARN',
  'ERROR',
])

export function normalizeManagedOpencodeServerLogLevel(value: unknown): ManagedOpencodeServerLogLevel | null {
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

function messageFromErrorArgs(args: unknown[]) {
  const first = args[0]
  if (first instanceof Error) return first.message
  return args.map((entry) => typeof entry === 'string' ? entry : JSON.stringify(entry)).join(' ')
}

function bindManagedOpencodeAbort(
  proc: ManagedOpencodeSupervisorProcess,
  signal?: AbortSignal,
  onAbort?: () => void,
) {
  if (!signal) return () => undefined
  const clear = () => {
    signal.removeEventListener('abort', abort)
  }
  const abort = () => {
    clear()
    onAbort?.()
    proc.postMessage({ type: 'shutdown' })
    proc.kill()
  }

  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  return clear
}

export async function createManagedOpencodeServerWithSupervisor(options: OpencodeServerOptions & {
  env: NodeJS.ProcessEnv
  forkSupervisor: ManagedOpencodeSupervisorFork
  supervisorPath: string
  startOnSpawnFallbackMs?: number | null
  onUnexpectedExit?: (event: ManagedOpencodeServerUnexpectedExit) => void
  opencodeBinPath?: string | null
  logLevel?: ManagedOpencodeServerLogLevel
  cwd?: string
}) {
  const resolved = {
    hostname: '127.0.0.1',
    port: 4096,
    startOnSpawnFallbackMs: 100,
    timeout: 5000,
    ...options,
  }
  const args = ['serve', `--hostname=${resolved.hostname}`, `--port=${resolved.port}`]
  const logLevel = normalizeManagedOpencodeServerLogLevel(resolved.logLevel)
    || normalizeManagedOpencodeServerLogLevel((resolved.config as { logLevel?: unknown } | undefined)?.logLevel)
  if (logLevel) args.push(`--log-level=${logLevel}`)

  const spawnPlan = resolveManagedOpencodeSpawn(resolved.env, args, process.platform, resolved.opencodeBinPath)
  const proc = resolved.forkSupervisor(resolved.supervisorPath)
  const bootMessage: ManagedOpencodeServerParentMessage = {
    type: 'boot',
    command: spawnPlan.command,
    args: spawnPlan.args,
    env: buildManagedOpencodeServerEnvironment(resolved.env, resolved.config),
    cwd: resolved.cwd,
    timeoutMs: resolved.timeout,
  }

  let clearAbort: () => void = () => undefined
  let closeRequested = false
  let startupSettled = false
  let started = false
  let startupTimer: NodeJS.Timeout | null = null

  function clearStartupTimer() {
    if (!startupTimer) return
    clearTimeout(startupTimer)
    startupTimer = null
  }

  function shutdownSupervisor() {
    closeRequested = true
    clearAbort()
    clearStartupTimer()
    try {
      proc.postMessage({ type: 'shutdown' })
    } catch {
      // The supervisor process may already be gone.
    }
    setTimeout(() => {
      try {
        proc.kill()
      } catch {
        // The supervisor process may already be gone.
      }
    }, 1500).unref()
  }

  const url = await new Promise<string>((resolveUrl, reject) => {
    function cleanupStartupListeners() {
      proc.off('spawn', onSpawn)
      proc.off('error', onError)
    }

    function rejectStartup(error: Error) {
      if (startupSettled) return
      startupSettled = true
      cleanupStartupListeners()
      shutdownSupervisor()
      reject(error)
    }

    function onSpawn() {
      if (started || startupSettled || closeRequested) return
      started = true
      proc.postMessage(bootMessage)
    }

    function onMessage(message: ManagedOpencodeServerSupervisorMessage) {
      if (message.type === 'supervisor-ready') {
        onSpawn()
        return
      }
      if (message.type === 'ready') {
        if (startupSettled) return
        startupSettled = true
        clearStartupTimer()
        cleanupStartupListeners()
        resolveUrl(message.url)
        return
      }
      if (message.type === 'startup-error') {
        rejectStartup(new Error(message.stdoutTail.trim()
          ? `${message.message}\nServer output: ${message.stdoutTail}`
          : message.message))
        return
      }
      if (message.type === 'exited' && startupSettled && !closeRequested) {
        resolved.onUnexpectedExit?.({ code: message.code, signal: message.signal })
      } else if (message.type === 'exited' && !startupSettled) {
        rejectStartup(new Error(`Server exited with code ${message.code}`))
      }
    }

    function onExit(code: number | null, signal?: NodeJS.Signals | null) {
      if (!startupSettled) {
        rejectStartup(new Error(`Managed OpenCode supervisor exited with code ${code}`))
        return
      }
      if (!closeRequested) {
        resolved.onUnexpectedExit?.({ code, signal: signal || null })
      }
    }

    function onError(...errorArgs: unknown[]) {
      rejectStartup(new Error(messageFromErrorArgs(errorArgs) || 'Managed OpenCode supervisor failed.'))
    }

    startupTimer = setTimeout(() => {
      rejectStartup(new Error(`Timeout waiting for server to start after ${resolved.timeout}ms`))
    }, resolved.timeout)

    proc.on('message', onMessage)
    proc.on('spawn', onSpawn)
    proc.on('exit', onExit)
    proc.on('error', onError)
    clearAbort = bindManagedOpencodeAbort(proc, resolved.signal, () => {
      const reason = resolved.signal?.reason
      rejectStartup(reason instanceof Error
        ? reason
        : new Error(reason === undefined ? 'Managed OpenCode server startup aborted.' : String(reason)))
    })

    // Process implementations differ on when they emit `spawn`, and a message
    // posted immediately after fork can race the supervisor's listener. Prefer
    // the explicit supervisor-ready handshake, with a short fallback for older
    // process implementations that only expose `spawn`.
    if (resolved.startOnSpawnFallbackMs !== null) {
      setTimeout(() => {
        if (!started && !startupSettled && !closeRequested) onSpawn()
      }, resolved.startOnSpawnFallbackMs).unref()
    }
  })

  return {
    url,
    close() {
      shutdownSupervisor()
    },
  }
}
