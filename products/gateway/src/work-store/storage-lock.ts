import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  STORAGE_OPERATION_LOCK_NAME,
  STORAGE_OPERATION_LOCK_STALE_MS,
} from './types.js'

/** Fail closed while a backup/restore lock file is fresh for this state dir. */
export function assertNoStorageOperationInProgress(filePath: string): void {
  const lockPath = path.join(path.dirname(path.resolve(filePath)), STORAGE_OPERATION_LOCK_NAME)
  try {
    const stat = fs.statSync(lockPath)
    if (Date.now() - stat.mtimeMs > STORAGE_OPERATION_LOCK_STALE_MS) return
    throw new Error('Gateway storage operation in progress; retry after backup/restore completes')
  } catch (err: any) {
    if (err?.code === 'ENOENT') return
    if (err?.message?.includes('Gateway storage operation in progress')) throw err
    return
  }
}
