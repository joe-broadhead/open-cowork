import { existsSync, realpathSync, statSync } from 'fs'
import { resolve } from 'path'

export type ProjectDirectoryTrustSource = 'dialog' | 'session-record' | 'automation-record'

export type ProjectDirectoryTrustLookup = (
  directory: string,
) => ProjectDirectoryTrustSource | null

export class ProjectDirectoryGrantRegistry {
  private readonly grantedDirectories = new Set<string>()
  private readonly lookupTrustSource: ProjectDirectoryTrustLookup

  constructor(lookupTrustSource: ProjectDirectoryTrustLookup = () => null) {
    this.lookupTrustSource = lookupTrustSource
  }

  grant(directory: string) {
    const normalized = normalizeProjectDirectory(directory)
    this.grantedDirectories.add(normalized)
    return normalized
  }

  has(directory: string) {
    const normalized = normalizeProjectDirectory(directory)
    return this.grantedDirectories.has(normalized) || this.lookupTrustSource(normalized) !== null
  }

  resolve(directory?: string | null) {
    if (!directory) return null
    const normalized = normalizeProjectDirectory(directory)
    if (this.grantedDirectories.has(normalized) || this.lookupTrustSource(normalized) !== null) {
      return normalized
    }
    throw new Error('Project directory must be selected with the native directory picker before use.')
  }
}

export function normalizeProjectDirectory(directory: string) {
  const resolved = resolve(directory)
  if (!existsSync(resolved)) return resolved
  const stat = statSync(resolved)
  if (!stat.isDirectory()) {
    throw new Error('Project path must be a directory.')
  }
  return realpathSync.native(resolved)
}

export function trustedRecordDirectoryMatches(candidate: string, stored?: string | null) {
  if (!stored) return false
  return resolve(stored) === candidate
}
