import type { ServerOptions as OpencodeServerOptions } from '@opencode-ai/sdk/v2/server'
import { randomBytes } from 'node:crypto'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  type ManagedOpencodeServerParentMessage,
  type ManagedOpencodeServerSupervisorMessage,
} from './runtime-managed-server-protocol.js'
import { appendManagedOpencodeOutputTail } from './runtime-managed-server-output.js'

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
  stdout?: { resume(): unknown; on?(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
  stderr?: { resume(): unknown; on?(event: 'data', listener: (chunk: Buffer) => void): unknown } | null
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

function snapshotManagedNativeAgents(env: NodeJS.ProcessEnv, configDir: string) {
  const configHome = env.XDG_CONFIG_HOME?.trim()
  if (!configHome) return

  const sourceDir = join(configHome, 'opencode', 'agents')
  let entries
  try {
    entries = readdirSync(sourceDir, { withFileTypes: true })
  } catch {
    return
  }

  // Disabled agents are deliberately stored as `<name>.disabled.md` by the
  // Open Cowork native customization store. OpenCode treats every discovered
  // Markdown file as an agent, so only snapshot the enabled native files.
  const enabledAgents = entries.filter((entry) =>
    entry.isFile()
    && entry.name.endsWith('.md')
    && !entry.name.endsWith('.disabled.md'),
  )
  if (enabledAgents.length === 0) return

  const targetDir = join(configDir, 'agents')
  mkdirSync(targetDir, { recursive: true, mode: 0o700 })
  for (const entry of enabledAgents) {
    const target = join(targetDir, entry.name)
    copyFileSync(join(sourceDir, entry.name), target)
    chmodSync(target, 0o600)
  }
}

/**
 * Optional AI-SDK provider packages to seed into OPENCODE_CONFIG_DIR/node_modules.
 *
 * OpenRouter no longer needs `@openrouter/ai-sdk-provider` here: managed V2 serve
 * forces `npm: @ai-sdk/openai-compatible` via composed config + settings apiKey
 * (see `buildOpenRouterProviderRuntimeConfig`). Keep this hook empty unless a
 * future provider requires a non-bundled package that OpenCode cannot resolve.
 */
const MANAGED_PROVIDER_NPM_PACKAGES: readonly string[] = []

/**
 * Seed optional AI-SDK provider packages into the temp OPENCODE_CONFIG_DIR.
 * No-op while MANAGED_PROVIDER_NPM_PACKAGES is empty.
 */
export function seedManagedProviderPackages(env: NodeJS.ProcessEnv, configDir: string) {
  if (MANAGED_PROVIDER_NPM_PACKAGES.length === 0) return
  const configHome = env.XDG_CONFIG_HOME?.trim()
  if (!configHome) return

  const seeded: string[] = []
  for (const packageName of MANAGED_PROVIDER_NPM_PACKAGES) {
    const source = join(configHome, 'opencode', 'node_modules', ...packageName.split('/'))
    if (!existsSync(join(source, 'package.json'))) continue
    const target = join(configDir, 'node_modules', ...packageName.split('/'))
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target, { recursive: true, force: true, dereference: true })
    seeded.push(packageName)
  }
  if (seeded.length === 0) return

  const packageJsonPath = join(configDir, 'package.json')
  let packageJson: { dependencies?: Record<string, string> } = { dependencies: {} }
  if (existsSync(packageJsonPath)) {
    try {
      packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as typeof packageJson
    } catch {
      packageJson = { dependencies: {} }
    }
  }
  const dependencies = { ...(packageJson.dependencies || {}) }
  for (const packageName of seeded) {
    const versionPath = join(configDir, 'node_modules', ...packageName.split('/'), 'package.json')
    try {
      const version = (JSON.parse(readFileSync(versionPath, 'utf8')) as { version?: string }).version
      dependencies[packageName] = version ? String(version) : dependencies[packageName] || '*'
    } catch {
      dependencies[packageName] = dependencies[packageName] || '*'
    }
  }
  writeFileSync(packageJsonPath, `${JSON.stringify({ ...packageJson, dependencies }, null, 2)}\n`, { mode: 0o644 })
}

export function buildManagedOpencodeServerEnvironment(
  env: NodeJS.ProcessEnv,
  config?: OpencodeServerOptions['config'],
  options: {
    writeConfigFile?: (serialized: string) => string
    onTempConfigDirCreated?: (dir: string) => void
  } = {},
) {
  const next = { ...env }
  delete next.OPENCODE_CONFIG_CONTENT
  if (config !== undefined) {
    const serialized = JSON.stringify(config ?? {})
    const writeConfigFile = options.writeConfigFile || ((content: string) => {
      // OpenCode V2 discovers composed agents, skills, and providers through
      // its native config directory. Keep that config credential-class: a
      // private directory and an owner-only canonical opencode.json file.
      const dir = mkdtempSync(join(tmpdir(), 'open-cowork-opencode-config-'))
      const file = join(dir, 'opencode.json')
      try {
        writeFileSync(file, content, { mode: 0o600 })
        // OPENCODE_CONFIG_DIR replaces the normal XDG OpenCode directory for
        // both config documents and native agent discovery. Snapshot the
        // enabled app-owned Markdown agents beside the composed config so V2
        // sees the exact catalog selected for this runtime generation.
        snapshotManagedNativeAgents(env, dir)
        // Seed AI-SDK provider packages (e.g. OpenRouter) into the temp config
        // dir so OpenCode can load them without a network install on every boot.
        seedManagedProviderPackages(env, dir)
      } catch (error) {
        // If the write fails the server object (and its close() cleanup hook) is never
        // returned, so remove the freshly created dir here rather than leaking it.
        rmSync(dir, { recursive: true, force: true })
        throw error
      }
      // Only register the dir for lifecycle cleanup once it actually holds the file.
      options.onTempConfigDirCreated?.(dir)
      return file
    })
    const configFile = writeConfigFile(serialized)
    if (basename(configFile) !== 'opencode.json' && basename(configFile) !== 'opencode.jsonc') {
      throw new Error('Managed OpenCode config writer must return an opencode.json or opencode.jsonc path.')
    }
    // OPENCODE_CONFIG_CONTENT is consumed only by OpenCode's classic config
    // layer. OPENCODE_CONFIG_DIR is shared by the classic and V2
    // layers, so one native file keeps both execution surfaces in lockstep and
    // avoids Linux's per-environment-string E2BIG limit at every config size.
    delete next.OPENCODE_CONFIG
    next.OPENCODE_CONFIG_DIR = dirname(configFile)
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
  onUnexpectedExit?: (event: ManagedOpencodeServerUnexpectedExit) => void
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
  const proc = resolved.forkSupervisor(resolved.supervisorPath)
  // Tracks the private native config directory so teardown removes its
  // credential-bearing file after OpenCode stops.
  let tempConfigDir: string | null = null
  const bootMessage: ManagedOpencodeServerParentMessage = {
    type: 'boot',
    command: spawnPlan.command,
    args: spawnPlan.args,
    env: buildManagedOpencodeServerEnvironment(resolved.env, resolved.config, {
      onTempConfigDirCreated: (dir) => {
        tempConfigDir = dir
      },
    }),
    cwd: resolved.cwd,
    timeoutMs: resolved.timeout,
  }

  let clearAbort: () => void = () => undefined
  // Detaches the long-lived message/exit/error/spawn listeners (audit P3-12). Without it, close()
  // tore down the process but left its listeners attached — a per-reboot leak on the parent process.
  let detachSupervisorListeners: () => void = () => undefined
  let closeRequested = false
  let startupSettled = false
  let started = false
  let startupTimer: NodeJS.Timeout | null = null
  let supervisorOutputTail = ''

  proc.stdout?.on?.('data', (chunk: Buffer) => {
    supervisorOutputTail = appendManagedOpencodeOutputTail(supervisorOutputTail, chunk.toString())
  })
  proc.stderr?.on?.('data', (chunk: Buffer) => {
    supervisorOutputTail = appendManagedOpencodeOutputTail(supervisorOutputTail, chunk.toString())
  })

  function withSupervisorOutput(message: string) {
    const tail = supervisorOutputTail.trim()
    return tail ? `${message}\nSupervisor output: ${tail}` : message
  }

  function clearStartupTimer() {
    if (!startupTimer) return
    clearTimeout(startupTimer)
    startupTimer = null
  }

  function cleanupTempConfigDir() {
    if (!tempConfigDir) return
    const dir = tempConfigDir
    tempConfigDir = null
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // Best-effort: leave the 0700 dir for the OS temp cleaner if removal fails.
    }
  }

  function shutdownSupervisor() {
    closeRequested = true
    clearAbort()
    clearStartupTimer()
    cleanupTempConfigDir()
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
      proc.off('error', onError)
    }

    function rejectStartup(error: Error) {
      if (startupSettled) return
      startupSettled = true
      cleanupStartupListeners()
      shutdownSupervisor()
      reject(error)
    }

    function sendBoot() {
      if (started || startupSettled || closeRequested) return
      started = true
      proc.postMessage(bootMessage)
    }

    function onMessage(message: ManagedOpencodeServerSupervisorMessage) {
      if (message.type === 'supervisor-ready') {
        sendBoot()
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
        cleanupTempConfigDir()
        resolved.onUnexpectedExit?.({ code: message.code, signal: message.signal })
      } else if (message.type === 'exited' && !startupSettled) {
        rejectStartup(new Error(`Server exited with code ${message.code}`))
      }
    }

    function onExit(code: number | null, signal?: NodeJS.Signals | null) {
      if (!startupSettled) {
        rejectStartup(new Error(withSupervisorOutput(`Managed OpenCode supervisor exited with code ${code}`)))
        return
      }
      cleanupTempConfigDir()
      if (!closeRequested) {
        resolved.onUnexpectedExit?.({ code, signal: signal || null })
      }
    }

    function onError(...errorArgs: unknown[]) {
      rejectStartup(new Error(withSupervisorOutput(messageFromErrorArgs(errorArgs) || 'Managed OpenCode supervisor failed.')))
    }

    startupTimer = setTimeout(() => {
      rejectStartup(new Error(`Timeout waiting for server to start after ${resolved.timeout}ms`))
    }, resolved.timeout)

    proc.on('message', onMessage)
    proc.on('exit', onExit)
    proc.on('error', onError)
    detachSupervisorListeners = () => {
      proc.off('message', onMessage)
      proc.off('exit', onExit)
      proc.off('error', onError)
    }
    clearAbort = bindManagedOpencodeAbort(proc, resolved.signal, () => {
      const reason = resolved.signal?.reason
      rejectStartup(reason instanceof Error
        ? reason
        : new Error(reason === undefined ? 'Managed OpenCode server startup aborted.' : String(reason)))
    })

    // Boot is sent only after the current supervisor explicitly confirms that
    // its message listener is installed. This removes the spawn-time race.
  })

  return {
    url,
    close() {
      shutdownSupervisor()
      // Remove the runtime listeners so a closed supervisor leaves nothing attached to the parent.
      detachSupervisorListeners()
    },
  }
}
