import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from 'fs'
import { homedir } from 'os'
import { dirname, join, resolve } from 'path'
import { getRuntimeHomeDir } from './runtime-paths.ts'

// Keep OpenCode's HOME sandbox self-contained while still exposing the
// standard developer-tool config that runtime-invoked commands expect.
// Deliberately omit any OpenCode / Claude / agent compatibility roots.
const DEFAULT_TOOLING_BRIDGE_ENTRIES = [
  '.gitconfig',
  '.gitignore',
  '.gitignore_global',
  '.gitmessage',
  '.npmrc',
  '.pnpmrc',
  '.yarnrc',
  '.yarnrc.yml',
  '.netrc',
  '.ssh',
  '.aws',
  '.azure',
  '.docker',
  '.kube',
  '.config/git',
  '.config/gh',
  '.config/gh-copilot',
  '.config/gcloud',
  '.config/npm',
  '.config/yarn',
  '.config/pnpm',
] as const

export function getRuntimeHomeToolingBridgeEntries() {
  return [...DEFAULT_TOOLING_BRIDGE_ENTRIES]
}

function normalizeTarget(target: string) {
  try {
    const stats = lstatSync(target)
    if (!stats.isSymbolicLink()) return null
    return resolve(dirname(target), readlinkSync(target))
  } catch {
    return null
  }
}

function removeTargetIfPresent(target: string) {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // best-effort cleanup only
  }
}

function ensureLinkedPath(source: string, target: string) {
  mkdirSync(dirname(target), { recursive: true })
  const linkedTarget = normalizeTarget(target)
  if (linkedTarget === source) return
  if (existsSync(target) || linkedTarget) {
    removeTargetIfPresent(target)
  }
  const sourceStats = lstatSync(source)
  const linkType = process.platform === 'win32'
    ? (sourceStats.isDirectory() ? 'junction' : 'file')
    : (sourceStats.isDirectory() ? 'dir' : 'file')
  symlinkSync(source, target, linkType)
}

export function syncRuntimeHomeToolingBridge(options?: {
  runtimeHome?: string
  realHome?: string
  entries?: string[]
}) {
  const runtimeHome = options?.runtimeHome || getRuntimeHomeDir()
  const realHome = options?.realHome || homedir()
  const entries = options?.entries || getRuntimeHomeToolingBridgeEntries()

  for (const relativePath of entries) {
    const source = join(realHome, relativePath)
    const target = join(runtimeHome, relativePath)
    if (!existsSync(source)) {
      removeTargetIfPresent(target)
      continue
    }
    ensureLinkedPath(source, target)
  }
}
