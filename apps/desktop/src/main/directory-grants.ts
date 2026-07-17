import { IpcSecurityError } from '@open-cowork/shared/ipc-security-errors'
import { realpathSync, statSync } from 'fs'
import { resolve } from 'path'

export type ProjectDirectoryTrustSource = 'dialog' | 'session-record' | 'workflow-record'

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
    throw new IpcSecurityError({
      code: 'DIRECTORY_GRANT_REQUIRED',
      message: 'Project directory must be selected with the native directory picker before use.',
      recovery: 'Choose the folder again with the native picker to grant access.',
    })
  }
}

export function normalizeProjectDirectory(directory: string) {
  const resolved = resolve(directory)
  // JOE-834: always realpath and refuse missing paths so grants cannot be
  // booked against a path that later appears as a symlink to an untrusted tree.
  let stat
  try {
    stat = statSync(resolved)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new IpcSecurityError({
      code: 'DIRECTORY_GRANT_MISSING_PATH',
      message: 'Project directory must exist before it can be granted.',
      recovery: 'Create the folder, then re-select it with the native directory picker.',
    })
    }
    throw error
  }
  if (!stat.isDirectory()) {
    throw new IpcSecurityError({
      code: 'DIRECTORY_GRANT_NOT_DIRECTORY',
      message: 'Project path must be a directory.',
      recovery: 'Select a folder, not a file.',
    })
  }
  const realPath = realpathSync.native(resolved)
  if (!statSync(realPath).isDirectory()) {
    throw new IpcSecurityError({
      code: 'DIRECTORY_GRANT_NOT_DIRECTORY',
      message: 'Project path must be a directory.',
      recovery: 'Select a folder, not a file.',
    })
  }
  return realPath
}

export function trustedRecordDirectoryMatches(candidate: string, stored?: string | null) {
  if (!stored) return false
  return resolve(stored) === candidate
}
