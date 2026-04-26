import { execFile } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, delimiter, join } from 'path'
import { log } from './logger.ts'

let shellEnvironmentCache: Record<string, string> | null | undefined
let shellEnvironmentLoadPromise: Promise<Record<string, string> | null> | null = null
const SHELL_ENV_STARTUP_WAIT_MS = 1500
const TRUSTED_SHELL_PATHS = new Set([
  '/bin/bash',
  '/bin/dash',
  '/bin/sh',
  '/bin/zsh',
  '/usr/bin/bash',
  '/usr/bin/dash',
  '/usr/bin/sh',
  '/usr/bin/zsh',
  '/usr/local/bin/bash',
  '/usr/local/bin/sh',
  '/usr/local/bin/zsh',
  '/opt/homebrew/bin/sh',
  '/opt/homebrew/bin/zsh',
  '/opt/homebrew/bin/bash',
  '/run/current-system/sw/bin/bash',
  '/run/current-system/sw/bin/sh',
  '/run/current-system/sw/bin/zsh',
])
const TRUSTED_NIX_SHELL_NAMES = new Set(['bash', 'dash', 'sh', 'zsh'])

function parseNullSeparatedEnvironment(stdout: string) {
  const env: Record<string, string> = {}
  for (const segment of stdout.split('\0')) {
    if (!segment) continue
    const equalsIndex = segment.indexOf('=')
    if (equalsIndex <= 0) continue
    const key = segment.slice(0, equalsIndex)
    const value = segment.slice(equalsIndex + 1)
    env[key] = value
  }
  return env
}

function loadEnvironmentFromShellAsync(shellPath: string, args: string[]) {
  return new Promise<Record<string, string> | null>((resolve) => {
    execFile(
      shellPath,
      args,
      {
        encoding: 'utf-8',
        timeout: 5000,
        env: {
          HOME: homedir(),
          USER: process.env.USER || '',
          TERM: 'xterm-256color',
        },
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error || !stdout) {
          resolve(null)
          return
        }
        resolve(parseNullSeparatedEnvironment(stdout))
      },
    )
  })
}

function fallbackShellPath() {
  return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
}

export function isTrustedResolvedShellPath(resolvedPath: string) {
  if (TRUSTED_SHELL_PATHS.has(resolvedPath)) return true
  if (resolvedPath.startsWith('/nix/store/')) {
    return TRUSTED_NIX_SHELL_NAMES.has(basename(resolvedPath))
  }
  return false
}

export function isTrustedShellPath(shellPath: string | null | undefined) {
  if (!shellPath || /(?:^|\/)(nu|nushell)$/.test(shellPath)) return false
  try {
    if (!existsSync(shellPath)) return false
    const resolvedPath = realpathSync(shellPath)
    return isTrustedResolvedShellPath(resolvedPath)
  } catch {
    return false
  }
}

function resolveShellPath() {
  const configuredShell = process.env.SHELL || fallbackShellPath()
  if (isTrustedShellPath(configuredShell)) {
    return realpathSync(configuredShell)
  }
  const fallback = fallbackShellPath()
  if (isTrustedShellPath(fallback)) {
    return realpathSync(fallback)
  }
  return null
}

function startShellEnvironmentLoad() {
  if (shellEnvironmentCache !== undefined) {
    return Promise.resolve(shellEnvironmentCache)
  }
  if (shellEnvironmentLoadPromise) {
    return shellEnvironmentLoadPromise
  }
  if (process.platform === 'win32') {
    shellEnvironmentCache = null
    return Promise.resolve(shellEnvironmentCache)
  }

  const shellPath = resolveShellPath()
  if (!shellPath) {
    shellEnvironmentCache = null
    return Promise.resolve(shellEnvironmentCache)
  }

  shellEnvironmentLoadPromise = (async () => {
    const resolved =
      await loadEnvironmentFromShellAsync(shellPath, ['-ilc', 'env -0'])
      || await loadEnvironmentFromShellAsync(shellPath, ['-lc', 'env -0'])
      || null
    shellEnvironmentCache = resolved
    shellEnvironmentLoadPromise = null
    if (resolved) {
      mergeShellEnvironment(resolved)
      log('runtime', 'Shell environment loaded asynchronously')
    } else {
      log('runtime', 'Shell environment unavailable; using fallback PATH entries')
    }
    return resolved
  })()

  return shellEnvironmentLoadPromise
}

export function primeShellEnvironment() {
  void startShellEnvironmentLoad()
}

export function getShellEnvironment() {
  return shellEnvironmentCache
}

function dedupePathEntries(entries: string[]) {
  const seen = new Set<string>()
  const deduped: string[] = []
  for (const entry of entries) {
    if (!entry) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    deduped.push(entry)
  }
  return deduped
}

function mergeShellEnvironment(shellEnvironment: Record<string, string>) {
  const currentEnvironment = { ...process.env }
  const shellPathEntries = (shellEnvironment.PATH || '').split(delimiter)
  const currentPathEntries = (currentEnvironment.PATH || '').split(delimiter)

  Object.assign(process.env, shellEnvironment, currentEnvironment, {
    PATH: dedupePathEntries([...shellPathEntries, ...currentPathEntries]).join(delimiter),
  })
}

function applyFallbackPath() {
  const currentEnvironment = { ...process.env }
  const fallbackPaths = dedupePathEntries([
    join(homedir(), '.opencode', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    join(homedir(), '.cargo', 'bin'),
    ...(currentEnvironment.PATH || '').split(delimiter),
  ])
  process.env.PATH = fallbackPaths.join(delimiter)
}

export async function prepareShellEnvironment(options?: { maxWaitMs?: number }) {
  const shellEnvironment = shellEnvironmentCache !== undefined
    ? shellEnvironmentCache
    : await Promise.race<Record<string, string> | null>([
      startShellEnvironmentLoad(),
      new Promise<Record<string, string> | null>((resolve) => {
        setTimeout(() => resolve(null), options?.maxWaitMs ?? SHELL_ENV_STARTUP_WAIT_MS)
      }),
    ])
  if (!shellEnvironment) {
    applyFallbackPath()
    log('runtime', 'Shell environment not ready; using fallback PATH entries')
    return null
  }
  return shellEnvironment
}

export function applyShellEnvironment() {
  const shellEnvironment = shellEnvironmentCache
  if (!shellEnvironment) {
    applyFallbackPath()
    log('runtime', 'Shell environment unavailable; using fallback PATH entries')
    return null
  }

  mergeShellEnvironment(shellEnvironment)
  return shellEnvironment
}
