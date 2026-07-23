import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { getConfig } from '../config.js'
import { closeWorkDb, resetWorkDbInitState } from '../work-store.js'
import {
  fsyncDirectory,
  fsyncFile,
  recoverInterruptedStorageRestore,
  storageRestoreJournalPath,
  writeStorageRestoreJournal,
  type StorageRestoreJournal,
  type StorageRestoreRecoveryResult,
} from '../work-store/db.js'
import { assertSupportedWorkStoreSchemaVersion, workStoreSchemaVersion } from '../work-store/schema.js'
import {
  CHANNEL_SYNC_OUTBOX_FILE,
  OPERATIONAL_SIDECAR_FILE,
  SIDECAR_FILES,
  DEFAULT_BACKUP_RETENTION,
  storageStateDir,
  workStatePathForStateDir,
  backupFilePath,
  restoreTargetPath,
  withReadOnlyStorageDb,
} from './internal.js'
import { verifyStorageBackup, createStorageBackup, withStorageOperationLock } from './backup.js'
import type { StorageRestoreOptions, StorageBackupVerification } from './types.js'

let restoreAfterInstallHookForTest: ((installedCount: number, name: string) => void) | undefined

export function setRestoreAfterInstallHookForTest(hook: ((installedCount: number, name: string) => void) | undefined): void {
  restoreAfterInstallHookForTest = hook
}

export async function restoreStorageBackup(inputPath: string, options: StorageRestoreOptions = {}): Promise<{ restored: string[]; safetyBackup?: string; verification: StorageBackupVerification }> {
  return restoreStorageBackupToStateDir(inputPath, storageStateDir(), options)
}
export async function restoreStorageBackupToStateDir(inputPath: string, targetStateDir: string, options: StorageRestoreOptions = {}): Promise<{ restored: string[]; safetyBackup?: string; verification: StorageBackupVerification }> {
  const verification = verifyStorageBackup(inputPath)
  if (!verification.ok) throw new Error(`backup verification failed: ${verification.errors.join('; ')}`)
  assertBackupSchemaCompatible(verification.path)
  if (!options.maintenanceMode && await isDaemonActive()) throw new Error('restore refused while Gateway daemon is active; stop the daemon or pass maintenanceMode=true')
  return withStorageOperationLock(targetStateDir, 'restore', () => {
    recoverStorageRestoreToStateDir(targetStateDir)
    const backupPath = verification.path
    const safetyBackup = options.skipSafetyBackup ? undefined : createStorageBackup({ label: 'pre-restore', retention: DEFAULT_BACKUP_RETENTION, stateDir: targetStateDir }).path
    const stateDir = path.resolve(targetStateDir)
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const stageDir = fs.mkdtempSync(path.join(stateDir, '.restore-stage-'))
    const newDir = path.join(stageDir, 'new')
    const rollbackDir = path.join(stageDir, 'rollback')
    fs.mkdirSync(newDir, { recursive: true, mode: 0o700 })
    fs.mkdirSync(rollbackDir, { recursive: true, mode: 0o700 })
    let journalWritten = false
    try {
      for (const file of verification.metadata!.files) {
        const source = backupFilePath(backupPath, file.name)
        const staged = path.join(newDir, file.name)
        fs.copyFileSync(source, staged)
        fsyncFile(staged)
        try { fs.chmodSync(staged, 0o600) } catch {}
      }
      fsyncDirectory(newDir)

      const dbPath = workStatePathForStateDir(targetStateDir)
      closeWorkDb(dbPath)
      resetWorkDbInitState(dbPath)
      const expected = new Map(verification.metadata!.files.map(file => [file.name, file.sha256]))
      const managedNames = restoreManagedFileNames()
      const entries = managedNames.map(name => {
        const target = path.join(stateDir, name)
        const hadTarget = fs.existsSync(target)
        if (hadTarget) {
          const rollback = path.join(rollbackDir, name)
          fs.copyFileSync(target, rollback)
          fsyncFile(rollback)
          try { fs.chmodSync(rollback, 0o600) } catch {}
        }
        return { name, expectedSha256: expected.get(name), hadTarget }
      })
      fsyncDirectory(rollbackDir)
      fsyncDirectory(stageDir)
      const journal: StorageRestoreJournal = {
        version: 1,
        operationId: `restore_${randomUUID()}`,
        stateDir,
        stageDirName: path.basename(stageDir),
        entries,
        createdAt: new Date().toISOString(),
      }
      writeStorageRestoreJournal(journal)
      journalWritten = true
      recoverInterruptedStorageRestore(stateDir, {
        afterInstall: (entry, installedCount) => restoreAfterInstallHookForTest?.(installedCount, entry.name),
      })
      resetWorkDbInitState(dbPath)
      const restored = verification.metadata!.files.map(file => restoreTargetPath(file.name, targetStateDir))
      return { restored, safetyBackup, verification }
    } finally {
      // Once the journal is durable, staged and rollback files are recovery
      // material and must survive an exception/process death. Startup recovery
      // removes them only after the whole generation is installed or restored.
      if (!journalWritten || !fs.existsSync(storageRestoreJournalPath(stateDir))) {
        try { fs.rmSync(stageDir, { recursive: true, force: true }) } catch {}
      }
    }
  })
}

export function recoverStorageRestoreToStateDir(targetStateDir: string): StorageRestoreRecoveryResult {
  const stateDir = path.resolve(targetStateDir)
  const dbPath = workStatePathForStateDir(stateDir)
  if (!fs.existsSync(storageRestoreJournalPath(stateDir))) return { recovered: false, installed: [] }
  closeWorkDb(dbPath)
  const result = recoverInterruptedStorageRestore(stateDir)
  resetWorkDbInitState(dbPath)
  return result
}

function restoreManagedFileNames(): string[] {
  const names = new Set(['gateway.db', CHANNEL_SYNC_OUTBOX_FILE, OPERATIONAL_SIDECAR_FILE, ...SIDECAR_FILES])
  for (const sqlite of ['gateway.db', CHANNEL_SYNC_OUTBOX_FILE, OPERATIONAL_SIDECAR_FILE]) {
    names.add(`${sqlite}-wal`)
    names.add(`${sqlite}-shm`)
  }
  return [...names]
}

function assertBackupSchemaCompatible(backupPath: string): void {
  withReadOnlyStorageDb(backupFilePath(backupPath, 'gateway.db'), readOnlyPath => {
    const db = new DatabaseSync(readOnlyPath, { readOnly: true })
    try {
      assertSupportedWorkStoreSchemaVersion(workStoreSchemaVersion(db))
    } finally {
      db.close()
    }
  })
}
async function isDaemonActive(): Promise<boolean> {
  for (const url of daemonHealthProbeUrls()) {
    if (await daemonHealthProbeActive(url)) return true
  }
  return false
}

function daemonHealthProbeUrls(): string[] {
  const cfg = getConfig()
  const hosts = new Set(['127.0.0.1'])
  const configured = cfg.security.httpHost.trim()
  if (configured && !['0.0.0.0', '::', '[::]'].includes(configured)) hosts.add(configured.replace(/^\[|\]$/g, ''))
  return [...hosts].map(host => {
    const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
    return `http://${bracketed}:${cfg.httpPort}/health`
  })
}

async function daemonHealthProbeActive(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 500)
  try {
    const res = await fetch(url, { signal: controller.signal })
    // Any HTTP response proves that a daemon (or another service) owns the
    // configured port. Authentication failures are especially important here:
    // exposed mode protects /health and must not be mistaken for a stopped
    // daemon merely because this local safety probe received 401/403.
    return Boolean(res)
  } catch (err) {
    if (controller.signal.aborted) return true
    const code = String((err as { cause?: { code?: unknown }; code?: unknown })?.cause?.code
      || (err as { code?: unknown })?.code
      || '')
      .toUpperCase()
    // A positive connection refusal is the only network failure that proves
    // nothing is listening. DNS, socket, TLS, and timeout ambiguity fail closed.
    return code !== 'ECONNREFUSED'
  } finally {
    clearTimeout(timer)
  }
}
