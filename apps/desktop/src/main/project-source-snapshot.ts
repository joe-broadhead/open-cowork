import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import type {
  CloudProjectSnapshotFile,
  CloudProjectSnapshotInventory,
  CloudProjectSnapshotUploadInput,
} from '@open-cowork/shared'
import {
  cloudProjectSnapshotPathReason,
  GENERATED_PROJECT_PATH_REASON,
  SECRET_PROJECT_PATH_REASON,
} from '@open-cowork/cloud-server/project-source-service'

const DEFAULT_MAX_FILES = 2000
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024

type SnapshotLimits = {
  maxFiles?: number
  maxBytes?: number
}

function toRelativePosix(root: string, path: string) {
  return relative(root, path).split(sep).join('/')
}

function shouldSkipDirectory(relativePath: string) {
  const reason = cloudProjectSnapshotPathReason(relativePath ? `${relativePath}/placeholder.txt` : 'placeholder.txt')
  if (reason === GENERATED_PROJECT_PATH_REASON || reason === SECRET_PROJECT_PATH_REASON) return reason
  const name = basename(relativePath).toLowerCase()
  if (name === '.git' || name === 'node_modules' || name === 'dist' || name === 'build') return GENERATED_PROJECT_PATH_REASON
  if (name === '.ssh' || name === '.aws' || name === '.azure') return SECRET_PROJECT_PATH_REASON
  return null
}

export async function buildCloudProjectSnapshotInventory(
  directory: string,
  limits: SnapshotLimits = {},
): Promise<CloudProjectSnapshotInventory> {
  const root = resolve(directory)
  const maxFiles = limits.maxFiles || DEFAULT_MAX_FILES
  const maxBytes = limits.maxBytes || DEFAULT_MAX_BYTES
  const files: CloudProjectSnapshotInventory['files'] = []
  const excluded: CloudProjectSnapshotInventory['excluded'] = []
  const warnings: string[] = []
  let byteCount = 0

  async function visit(current: string) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const absolute = join(current, entry.name)
      const relativePath = toRelativePosix(root, absolute)
      if (entry.isSymbolicLink()) {
        excluded.push({ path: relativePath, reason: 'symlink' })
        continue
      }
      if (entry.isDirectory()) {
        const directoryReason = shouldSkipDirectory(relativePath)
        if (directoryReason) {
          excluded.push({ path: relativePath, reason: directoryReason })
          continue
        }
        await visit(absolute)
        continue
      }
      if (!entry.isFile()) {
        excluded.push({ path: relativePath, reason: 'unsupported file type' })
        continue
      }
      const reason = cloudProjectSnapshotPathReason(relativePath)
      if (reason) {
        excluded.push({ path: relativePath, reason })
        continue
      }
      const size = (await stat(absolute)).size
      if (files.length + 1 > maxFiles) {
        excluded.push({ path: relativePath, reason: 'file limit exceeded' })
        continue
      }
      if (byteCount + size > maxBytes) {
        excluded.push({ path: relativePath, reason: 'byte limit exceeded' })
        continue
      }
      files.push({ path: relativePath, byteCount: size })
      byteCount += size
    }
  }

  await visit(root)
  if (excluded.some((entry) => entry.reason === SECRET_PROJECT_PATH_REASON)) {
    warnings.push('Secret-bearing files were excluded from the snapshot.')
  }
  if (excluded.some((entry) => entry.reason === GENERATED_PROJECT_PATH_REASON)) {
    warnings.push('Dependency and build output folders were excluded from the snapshot.')
  }
  return {
    rootDirectory: root,
    files,
    excluded,
    warnings,
    fileCount: files.length,
    byteCount,
    maxFiles,
    maxBytes,
  }
}

export async function buildCloudProjectSnapshotUpload(
  directory: string,
  limits: SnapshotLimits = {},
): Promise<CloudProjectSnapshotUploadInput> {
  const inventory = await buildCloudProjectSnapshotInventory(directory, limits)
  const root = resolve(directory)
  const files: CloudProjectSnapshotFile[] = []
  for (const file of inventory.files) {
    const absolute = resolve(root, ...file.path.split('/'))
    files.push({
      path: file.path,
      dataBase64: (await readFile(absolute)).toString('base64'),
      byteCount: file.byteCount,
    })
  }
  return {
    title: basename(root),
    files,
    excluded: inventory.excluded,
    warnings: inventory.warnings,
    fileCount: inventory.fileCount,
    byteCount: inventory.byteCount,
  }
}
