import { mkdirSync } from 'fs'
import type { NativeConfigScope } from './runtime-paths.ts'
import {
  getMachineAgentsDir,
  getMachineOpencodeConfigPath,
  getMachineSkillsDir,
  getProjectCoworkAgentsDir,
  getProjectCoworkConfigPath,
  getProjectCoworkSkillsDir,
  resolveProjectDirectory,
} from './runtime-paths.ts'
import { resolveExistingJsonConfigPath } from './jsonc.ts'

export type JsonRecord = Record<string, unknown>

export function ensureDirectory(path: string) {
  mkdirSync(path, { recursive: true })
  return path
}

export function targetDirectory(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    const resolved = resolveProjectDirectory(directory)
    if (!resolved) {
      throw new Error('Project scope requires a project directory.')
    }
    return resolved
  }
  return null
}

export function configPathForTarget(scope: NativeConfigScope, directory?: string | null) {
  const basePath = scope === 'project'
    ? getProjectCoworkConfigPath(targetDirectory(scope, directory)!)
    : getMachineOpencodeConfigPath()
  return resolveExistingJsonConfigPath(basePath)
}

export function skillsDirForTarget(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    return getProjectCoworkSkillsDir(targetDirectory(scope, directory)!)
  }
  return getMachineSkillsDir()
}

export function agentsDirForTarget(scope: NativeConfigScope, directory?: string | null) {
  if (scope === 'project') {
    return getProjectCoworkAgentsDir(targetDirectory(scope, directory)!)
  }
  return getMachineAgentsDir()
}

export function mergeByName<T extends { name: string }>(items: T[]) {
  const merged = new Map<string, T>()
  for (const item of items) {
    merged.set(item.name, item)
  }
  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name))
}

export function readStringArray(value: unknown) {
  if (!Array.isArray(value)) return undefined
  return Array.from(new Set(
    value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean),
  ))
}
