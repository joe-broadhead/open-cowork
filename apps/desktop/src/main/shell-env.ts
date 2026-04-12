import { spawnSync } from 'child_process'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { log } from './logger.ts'

let shellEnvironmentCache: Record<string, string> | null | undefined

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

function loadEnvironmentFromShell(shellPath: string, args: string[]) {
  const result = spawnSync(shellPath, args, {
    encoding: 'utf-8',
    timeout: 5000,
    env: {
      HOME: homedir(),
      USER: process.env.USER || '',
      TERM: 'xterm-256color',
    },
    maxBuffer: 10 * 1024 * 1024,
  })

  if (result.error || result.status !== 0 || !result.stdout) {
    return null
  }

  return parseNullSeparatedEnvironment(result.stdout)
}

export function getShellEnvironment() {
  if (shellEnvironmentCache !== undefined) return shellEnvironmentCache
  if (process.platform === 'win32') {
    shellEnvironmentCache = null
    return shellEnvironmentCache
  }

  const shellPath = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  if (/(?:^|\/)(nu|nushell)$/.test(shellPath)) {
    shellEnvironmentCache = null
    return shellEnvironmentCache
  }

  shellEnvironmentCache =
    loadEnvironmentFromShell(shellPath, ['-ilc', 'env -0'])
    || loadEnvironmentFromShell(shellPath, ['-lc', 'env -0'])
    || null

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

export function applyShellEnvironment() {
  const shellEnvironment = getShellEnvironment()
  const currentEnvironment = { ...process.env }

  if (!shellEnvironment) {
    const fallbackPaths = dedupePathEntries([
      join(homedir(), '.opencode', 'bin'),
      '/usr/local/bin',
      '/opt/homebrew/bin',
      join(homedir(), '.cargo', 'bin'),
      ...(currentEnvironment.PATH || '').split(delimiter),
    ])
    process.env.PATH = fallbackPaths.join(delimiter)
    log('runtime', 'Shell environment unavailable; using fallback PATH entries')
    return
  }

  const shellPathEntries = (shellEnvironment.PATH || '').split(delimiter)
  const currentPathEntries = (currentEnvironment.PATH || '').split(delimiter)

  Object.assign(process.env, shellEnvironment, currentEnvironment, {
    PATH: dedupePathEntries([...shellPathEntries, ...currentPathEntries]).join(delimiter),
  })
}
