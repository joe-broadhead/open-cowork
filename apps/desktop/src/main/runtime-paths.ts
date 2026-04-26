import { mkdirSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { getAppDataDir, getBrandName, getProjectOverlayDirName } from './config-loader.ts'

export type NativeConfigScope = 'machine' | 'project'
export const DEFAULT_SANDBOX_RETENTION_DAYS = 14

export function getRuntimeHomeDir() {
  return join(getAppDataDir(), 'runtime-home')
}

export function getSandboxRootDir() {
  if (process.env.OPEN_COWORK_SANDBOX_DIR) {
    return resolve(process.env.OPEN_COWORK_SANDBOX_DIR)
  }
  return join(homedir(), `${getBrandName()} Sandbox`)
}

export function isSandboxWorkspaceDir(directory?: string | null) {
  if (!directory) return false
  const normalized = resolve(directory)
  const sandboxRoot = getSandboxRootDir()
  return normalized === sandboxRoot || normalized.startsWith(`${sandboxRoot}/`)
}

export function createSandboxWorkspaceDir() {
  const sandboxRoot = getSandboxRootDir()
  mkdirSync(sandboxRoot, { recursive: true })
  const directory = join(sandboxRoot, `thread-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`)
  mkdirSync(directory, { recursive: true })
  return directory
}

export function getRuntimeEnvPaths() {
  const home = getRuntimeHomeDir()
  return {
    home,
    configHome: join(home, '.config'),
    dataHome: join(home, '.local', 'share'),
    cacheHome: join(home, '.cache'),
    stateHome: join(home, '.local', 'state'),
  }
}

export function getMachineOpencodeDir() {
  return join(getRuntimeEnvPaths().configHome, 'opencode')
}

export function getMachineOpencodeConfigPath() {
  return join(getMachineOpencodeDir(), 'opencode.json')
}

export function getMachineSkillsDir() {
  return join(getMachineOpencodeDir(), 'skills')
}

// Where the Cowork product gate keeps a bundled-skill mirror separate
// from the OpenCode-discoverable user skill directory. This mirror is
// useful for diagnostics and avoids treating bundled skills as user-authored
// content when the Capabilities UI or cleanup code inspects runtime state.
export function getManagedSkillsDir() {
  return join(getRuntimeHomeDir(), 'managed-skills')
}

export function getRuntimeSkillCatalogDir() {
  return join(getRuntimeHomeDir(), 'runtime-skill-catalog')
}

export function getMachineAgentsDir() {
  return join(getMachineOpencodeDir(), 'agents')
}

export function resolveProjectDirectory(directory?: string | null) {
  if (!directory) return null
  return resolve(directory)
}

export function getProjectOpencodeConfigPath(directory: string) {
  return join(resolve(directory), 'opencode.json')
}

export function getProjectSkillsDir(directory: string) {
  return join(resolve(directory), '.opencode', 'skills')
}

export function getProjectAgentsDir(directory: string) {
  return join(resolve(directory), '.opencode', 'agents')
}

export function getProjectCoworkDir(directory: string) {
  return join(resolve(directory), getProjectOverlayDirName())
}

export function getProjectCoworkConfigPath(directory: string) {
  return join(getProjectCoworkDir(directory), 'config.json')
}

export function getProjectCoworkSkillsDir(directory: string) {
  return join(getProjectCoworkDir(directory), 'skills')
}

export function getProjectCoworkAgentsDir(directory: string) {
  return join(getProjectCoworkDir(directory), 'agents')
}
