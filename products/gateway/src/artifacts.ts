import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'

export const RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION = 1
export const RUN_ARTIFACT_INLINE_VIEW_LIMIT_BYTES = 2 * 1024 * 1024

export type RunArtifactEntryStatus = 'available' | 'missing' | 'unsupported' | 'blocked'
export type RunArtifactRedactionStatus = 'redacted' | 'not_applicable' | 'blocked' | 'unknown'
export type RunArtifactRetentionPolicy = 'run_artifact' | 'external_reference'

interface RunArtifactEvidenceLike {
  ref?: string
}

interface RunArtifactResultLike {
  artifacts?: string[]
  evidence?: RunArtifactEvidenceLike[]
}

interface RunArtifactEnvironmentLike {
  artifacts?: string[]
}

export interface RunArtifactRunLike {
  id: string
  taskId: string
  stage: string
  sessionId: string
  startedAt?: string
  completedAt?: string
  environment?: RunArtifactEnvironmentLike
  result?: RunArtifactResultLike
}

export interface RunArtifactWorkStateLike {
  runs?: RunArtifactRunLike[]
}

export interface RunArtifactManifestEntry {
  id: string
  ref: string
  refHash: string
  runId: string
  taskId: string
  stage: string
  sessionId: string
  createdAt: string
  filename: string
  contentType: string
  status: RunArtifactEntryStatus
  redactionStatus: RunArtifactRedactionStatus
  retentionPolicy: RunArtifactRetentionPolicy
  previewSafe: boolean
  sizeBytes?: number
  sha256?: string
  omittedReason?: string
}

export interface RunArtifactManifest {
  schemaVersion: typeof RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION
  id: string
  runId: string
  taskId: string
  stage: string
  sessionId: string
  createdAt: string
  updatedAt: string
  workspace: {
    localOnly: true
    hostedCollaboration: false
    inlineViewLimitBytes: number
  }
  entries: RunArtifactManifestEntry[]
}

export interface RunArtifactManifestEntryView extends Omit<RunArtifactManifestEntry, 'ref'> {
  ref: string
  rawRefAvailable: false
}

export interface RunArtifactManifestView {
  schemaVersion: typeof RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION
  id: string
  runId: string
  taskId: string
  stage: string
  sessionId: string
  createdAt: string
  updatedAt: string
  manifestFound: boolean
  manifestPathHash: string
  retentionPolicies: RunArtifactRetentionPolicy[]
  redactionStatus: RunArtifactRedactionStatus
  counts: Record<RunArtifactEntryStatus, number>
  workspace: RunArtifactManifest['workspace']
  entries: RunArtifactManifestEntryView[]
}

export function collectRunArtifactRefs(run: RunArtifactRunLike): string[] {
  const refs = [
    ...(run.environment?.artifacts || []),
    ...(run.result?.artifacts || []),
    ...((run.result?.evidence || []).map(item => item.ref).filter(Boolean) as string[]),
  ]
  return uniqueStrings(refs)
}

export function runArtifactWorkspaceDir(runId: string, stateFilePath: string): string {
  return path.join(path.dirname(stateFilePath), 'artifacts', runId)
}

export function runArtifactManifestPath(runId: string, stateFilePath: string): string {
  return path.join(runArtifactWorkspaceDir(runId, stateFilePath), 'manifest.json')
}

export function writeRunArtifactManifest(run: RunArtifactRunLike, stateFilePath: string, options: { refs?: string[]; now?: string } = {}): RunArtifactManifest | undefined {
  const refs = uniqueStrings(options.refs || collectRunArtifactRefs(run))
  if (!refs.length) return undefined
  const now = options.now || new Date().toISOString()
  const manifest = buildRunArtifactManifest(run, refs, stateFilePath, now)
  const manifestPath = runArtifactManifestPath(run.id, stateFilePath)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  try { fs.chmodSync(manifestPath, 0o600) } catch {}
  return manifest
}

export function getRunArtifactManifestView(runId: string, state: RunArtifactWorkStateLike, stateFilePath: string): RunArtifactManifestView | undefined {
  const run = (state.runs || []).find(row => row.id === runId)
  if (!run) return undefined
  const stored = readStoredRunArtifactManifest(runId, stateFilePath)
  const manifest = stored || buildRunArtifactManifest(run, collectRunArtifactRefs(run), stateFilePath, run.completedAt || run.startedAt || new Date(0).toISOString())
  return toRunArtifactManifestView(refreshRunArtifactManifest(manifest, stateFilePath), stateFilePath, Boolean(stored))
}

export function listRunArtifactManifestViews(state: RunArtifactWorkStateLike, stateFilePath: string, options: { runId?: string; taskId?: string; limit?: number } = {}): RunArtifactManifestView[] {
  const limit = Math.max(1, Math.min(100, Number(options.limit || 50)))
  return (state.runs || [])
    .filter(run => !options.runId || run.id === options.runId)
    .filter(run => !options.taskId || run.taskId === options.taskId)
    .filter(run => collectRunArtifactRefs(run).length || fs.existsSync(runArtifactManifestPath(run.id, stateFilePath)))
    .sort((a, b) => String(b.completedAt || b.startedAt).localeCompare(String(a.completedAt || a.startedAt)))
    .slice(0, limit)
    .map(run => getRunArtifactManifestView(run.id, state, stateFilePath))
    .filter((view): view is RunArtifactManifestView => Boolean(view))
}

export function buildRunArtifactManifest(run: RunArtifactRunLike, refs: string[], stateFilePath: string, now: string): RunArtifactManifest {
  const stateDir = path.dirname(stateFilePath)
  const workspaceDir = runArtifactWorkspaceDir(run.id, stateFilePath)
  const entries = uniqueStrings(refs).map(ref => inspectRunArtifactRef(ref, run, stateDir, workspaceDir, now))
  return {
    schemaVersion: RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION,
    id: `artifact_manifest_${hashText(`${run.id}:${entries.map(entry => entry.refHash).join(',')}`).slice(0, 16)}`,
    runId: run.id,
    taskId: run.taskId,
    stage: run.stage,
    sessionId: run.sessionId,
    createdAt: now,
    updatedAt: now,
    workspace: {
      localOnly: true,
      hostedCollaboration: false,
      inlineViewLimitBytes: RUN_ARTIFACT_INLINE_VIEW_LIMIT_BYTES,
    },
    entries,
  }
}

function refreshRunArtifactManifest(manifest: RunArtifactManifest, stateFilePath: string): RunArtifactManifest {
  const stateDir = path.dirname(stateFilePath)
  const workspaceDir = runArtifactWorkspaceDir(manifest.runId, stateFilePath)
  const runRef = { id: manifest.runId, taskId: manifest.taskId, stage: manifest.stage, sessionId: manifest.sessionId }
  return {
    ...manifest,
    entries: manifest.entries.map(entry => {
      if (!localArtifactPath(entry.ref)) return entry
      const refreshed = inspectRunArtifactRef(entry.ref, runRef, stateDir, workspaceDir, entry.createdAt)
      return {
        ...entry,
        status: refreshed.status,
        sizeBytes: refreshed.sizeBytes,
        sha256: refreshed.sha256,
        redactionStatus: refreshed.redactionStatus,
        previewSafe: refreshed.previewSafe,
        omittedReason: refreshed.omittedReason,
      }
    }),
  }
}

function inspectRunArtifactRef(ref: string, run: Pick<RunArtifactRunLike, 'id' | 'taskId' | 'stage' | 'sessionId'>, stateDir: string, workspaceDir: string, now: string): RunArtifactManifestEntry {
  const normalized = String(ref || '').trim()
  const base = {
    id: `artifact_${hashText(`${run.id}:${normalized}`).slice(0, 16)}`,
    ref: normalized,
    refHash: hashText(normalized).slice(0, 16),
    runId: run.id,
    taskId: run.taskId,
    stage: run.stage,
    sessionId: run.sessionId,
    createdAt: now,
  }
  const localPath = localArtifactPath(normalized)
  if (!localPath) {
    return {
      ...base,
      filename: artifactSchemeLabel(normalized),
      contentType: 'application/octet-stream',
      status: 'unsupported',
      redactionStatus: 'not_applicable',
      retentionPolicy: 'external_reference',
      previewSafe: false,
      omittedReason: 'non-file artifact ref is retained as metadata only',
    }
  }
  const filePath = path.resolve(localPath)
  const filename = path.basename(filePath) || 'artifact'
  const retentionPolicy: RunArtifactRetentionPolicy = isChildPath(workspaceDir, filePath) || isChildPath(stateDir, filePath) ? 'run_artifact' : 'external_reference'
  const baseFile = {
    ...base,
    filename,
    contentType: contentTypeFor(filename),
    retentionPolicy,
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    return {
      ...baseFile,
      status: 'missing',
      redactionStatus: 'unknown',
      previewSafe: false,
      omittedReason: 'file not found',
    }
  }
  if (!stat.isFile()) {
    return {
      ...baseFile,
      status: 'unsupported',
      redactionStatus: 'unknown',
      previewSafe: false,
      omittedReason: 'artifact ref is not a file',
    }
  }
  const tooLarge = stat.size > RUN_ARTIFACT_INLINE_VIEW_LIMIT_BYTES
  const sha256 = tooLarge ? undefined : fileHash(filePath)
  if (!tooLarge && !sha256) {
    return {
      ...baseFile,
      status: 'missing',
      redactionStatus: 'unknown',
      previewSafe: false,
      omittedReason: 'file not found',
    }
  }
  return {
    ...baseFile,
    status: 'available',
    sizeBytes: stat.size,
    sha256,
    redactionStatus: tooLarge ? 'blocked' : 'redacted',
    previewSafe: !tooLarge,
    omittedReason: tooLarge ? 'artifact exceeds inline view limit' : undefined,
  }
}

function readStoredRunArtifactManifest(runId: string, stateFilePath: string): RunArtifactManifest | undefined {
  const manifestPath = runArtifactManifestPath(runId, stateFilePath)
  if (!fs.existsSync(manifestPath)) return undefined
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    if (!parsed || parsed.schemaVersion !== RUN_ARTIFACT_MANIFEST_SCHEMA_VERSION || !Array.isArray(parsed.entries)) return undefined
    return parsed as RunArtifactManifest
  } catch {
    return undefined
  }
}

function toRunArtifactManifestView(manifest: RunArtifactManifest, stateFilePath: string, manifestFound: boolean): RunArtifactManifestView {
  const counts: Record<RunArtifactEntryStatus, number> = { available: 0, missing: 0, unsupported: 0, blocked: 0 }
  for (const entry of manifest.entries) counts[entry.status] += 1
  const redactionStatus = aggregateRedactionStatus(manifest.entries.map(entry => entry.redactionStatus))
  const retentionPolicies = [...new Set(manifest.entries.map(entry => entry.retentionPolicy))]
  return {
    schemaVersion: manifest.schemaVersion,
    id: manifest.id,
    runId: manifest.runId,
    taskId: manifest.taskId,
    stage: manifest.stage,
    sessionId: manifest.sessionId,
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    manifestFound,
    manifestPathHash: hashText(runArtifactManifestPath(manifest.runId, stateFilePath)).slice(0, 16),
    retentionPolicies,
    redactionStatus,
    counts,
    workspace: manifest.workspace,
    entries: manifest.entries.map(entry => ({
      ...entry,
      ref: redactedArtifactRef(entry.ref),
      rawRefAvailable: false,
    })),
  }
}

function aggregateRedactionStatus(statuses: RunArtifactRedactionStatus[]): RunArtifactRedactionStatus {
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.includes('unknown')) return 'unknown'
  if (statuses.includes('redacted')) return 'redacted'
  return 'not_applicable'
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function artifactSchemeLabel(ref: string): string {
  const match = /^([a-z0-9+.-]+):/i.exec(ref)
  return match ? `${match[1]} artifact` : 'artifact'
}

function redactedArtifactRef(ref: string): string {
  const localPath = localArtifactPath(ref)
  if (localPath) {
    const filePath = path.resolve(localPath)
    const prefix = ref.startsWith('file:') ? 'file' : 'path'
    return `${prefix}:<gateway-artifact:${path.basename(filePath) || 'artifact'}#${hashText(filePath).slice(0, 12)}>`
  }
  const scheme = artifactSchemeLabel(ref).replace(/\s+artifact$/, '')
  return `${scheme}:<artifact#${hashText(ref).slice(0, 12)}>`
}

function localArtifactPath(ref: string): string | undefined {
  if (ref.startsWith('file:')) return ref.slice('file:'.length) || undefined
  if (ref.startsWith('/') || ref.startsWith('./') || ref.startsWith('../')) return ref
  return undefined
}

function contentTypeFor(filePath: string): string {
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  if (filePath.endsWith('.md')) return 'text/markdown; charset=utf-8'
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  return 'text/plain; charset=utf-8'
}

function isChildPath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function fileHash(filePath: string): string {
  try {
    const hash = createHash('sha256')
    const data = fs.readFileSync(filePath)
    hash.update(data)
    return hash.digest('hex')
  } catch {
    return ''
  }
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
