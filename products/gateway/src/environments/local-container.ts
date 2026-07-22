/**
 * Local-container environment backend (JOE-936 / JOE-919).
 * Leaf module — no import from environments.ts.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type {
  EnvironmentAcquisitionLookupResult,
  EnvironmentAcquisitionReleaseResult,
  EnvironmentArtifactCollectionResult,
  EnvironmentPreflightResult,
  EnvironmentPrepareOptions,
  EnvironmentReconciliationResult,
  EnvironmentRunRecord,
  EnvironmentSpec,
} from './types.js'
import {
  DEFAULT_CONTAINER_WORKDIR,
  SECRET_VALUE_PLACEHOLDER,
  binaryAvailable,
  environmentIdempotencyKeyHash,
  hashText,
  safePathPart,
  shortText,
  uniqueStrings,
} from './util.js'
import { reconcileEnvironmentRuns, releaseEnvironmentRun } from './lifecycle.js'

let prepareEnvironmentFn: ((spec: EnvironmentSpec, options?: EnvironmentPrepareOptions) => EnvironmentRunRecord) | undefined
export function setLocalContainerPrepareEnvironment(fn: NonNullable<typeof prepareEnvironmentFn>): void {
  prepareEnvironmentFn = fn
}
function prepareEnvironment(spec: EnvironmentSpec, options?: EnvironmentPrepareOptions): EnvironmentRunRecord {
  if (!prepareEnvironmentFn) throw new Error('local-container prepareEnvironment not configured')
  return prepareEnvironmentFn(spec, options)
}

const localContainerWarmPools = new Map<string, { warmedAt: string; runtime: string; image: string; specHash: string }>()

export function clearLocalContainerWarmPoolsForTest(): void {
  localContainerWarmPools.clear()
}

export function prepareLocalContainerEnvironment(spec: EnvironmentSpec, options: EnvironmentPrepareOptions = { taskId: 'unknown', stage: 'unknown' }): EnvironmentRunRecord {
  const workspaceHostPath = createLocalContainerWorkspace(spec, options)
  const containerSpec = { ...spec, workdir: workspaceHostPath || spec.workdir }
  const run = prepareEnvironment(containerSpec, options)
  const digest = inspectLocalContainerImage(spec)
  const commandRuntimePrefix = localContainerCommandPrefix(spec, run.workdir || spec.workdir)
  const commandCaptureDir = createLocalContainerCaptureDir(workspaceHostPath)
  const commandWrapper = createLocalContainerCommandWrapper(spec, run.workdir || spec.workdir, commandCaptureDir)
  const commandPrefix = [commandWrapper]
  const commandPreflight = preflightLocalContainerStageCommands(containerSpec, run.preflight)
  const warmPool = warmLocalContainerPool(spec, run.workdir || spec.workdir)
  return {
    ...run,
    status: commandPreflight.preflight.ok ? run.status : 'blocked',
    provider: 'local-container',
    preflight: commandPreflight.preflight,
    metadata: {
      ...run.metadata,
      originalWorkdir: spec.workdir,
      workspaceHostPath,
      containerWorkdir: localContainerWorkdir(spec),
      imageDigest: digest.digest,
      imageInspectStatus: digest.status,
      commandPrefix,
      runtimeCommandPrefix: commandRuntimePrefix,
      commandCaptureDir,
      commandWrapper,
      commandResults: commandPreflight.results.map(localContainerCommandSummary),
      warmPool: warmPool.enabled ? { key: warmPool.key, hit: warmPool.hit, warmedAt: warmPool.warmedAt, result: warmPool.result ? localContainerCommandSummary(warmPool.result) : undefined } : undefined,
      cacheVolumes: localContainerCacheVolumes(spec),
    },
  }
}

export function releaseLocalContainerEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  const workspace = typeof environment.metadata['workspaceHostPath'] === 'string' ? environment.metadata['workspaceHostPath'] : undefined
  if (workspace && isLocalContainerWorkspace(workspace)) fs.rmSync(path.dirname(workspace), { recursive: true, force: true })
  return releaseEnvironmentRun(environment)
}

export function lookupLocalContainerEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
  const target = localContainerWorkspaceTargetForKey(spec, idempotencyKey)
  const found = fs.existsSync(target.root)
  return {
    ok: true,
    found,
    backend: spec.backend,
    idempotencyKeyHash: target.idempotencyKeyHash,
    resourceId: found ? `local-container:${target.idempotencyKeyHash}` : undefined,
    state: found ? 'prepared' : undefined,
    metadata: { workspaceHostPath: target.workspace, root: target.root },
    evidence: [found ? `local-container workspace ${target.idempotencyKeyHash} is present` : `local-container workspace ${target.idempotencyKeyHash} was not found`],
  }
}

export function releaseLocalContainerEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
  const lookup = lookupLocalContainerEnvironmentByKey(spec, idempotencyKey)
  if (lookup.found) fs.rmSync(String(lookup.metadata['root']), { recursive: true, force: true })
  return {
    ok: true,
    found: lookup.found,
    released: lookup.found,
    backend: spec.backend,
    idempotencyKeyHash: lookup.idempotencyKeyHash,
    resourceId: lookup.resourceId,
    evidence: [...lookup.evidence, lookup.found ? `local-container workspace ${lookup.idempotencyKeyHash} released by acquisition key` : `local-container workspace ${lookup.idempotencyKeyHash} had nothing to release`],
  }
}

export function collectLocalContainerArtifacts(environment: EnvironmentRunRecord): EnvironmentArtifactCollectionResult {
  const artifacts = new Set(environment.artifacts)
  const evidence: string[] = []
  const captureDir = typeof environment.metadata['commandCaptureDir'] === 'string' ? environment.metadata['commandCaptureDir'] : undefined
  const captures = readLocalContainerCaptures(captureDir)
  for (const capture of captures) {
    artifacts.add(`file:${capture.metadataPath}`)
    if (capture['stdoutPath'] && fs.existsSync(capture['stdoutPath'])) artifacts.add(`file:${capture['stdoutPath']}`)
    if (capture['stderrPath'] && fs.existsSync(capture['stderrPath'])) artifacts.add(`file:${capture['stderrPath']}`)
  }
  if (captures.length) {
    const failed = captures.filter(capture => Number(capture['exitCode'] || 0) !== 0).length
    evidence.push(`local-container captured ${captures.length} command(s) with stdout/stderr/exit/timing metadata${failed ? `; failed=${failed}` : ''}`)
  }
  const workspace = typeof environment.metadata['workspaceHostPath'] === 'string' ? environment.metadata['workspaceHostPath'] : undefined
  for (const artifact of localContainerWorkspaceArtifacts(workspace)) artifacts.add(`file:${artifact}`)
  return {
    ok: true,
    artifacts: [...artifacts].sort(),
    evidence: evidence.length ? evidence : ['local-container has no captured command logs'],
  }
}

export function reconcileLocalContainerEnvironmentRuns(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult {
  const base = reconcileEnvironmentRuns(environments)
  const evidence = base.evidence.slice()
  for (const environment of environments.filter(row => row.backend === 'local-container')) {
    const workspace = typeof environment.metadata['workspaceHostPath'] === 'string' ? environment.metadata['workspaceHostPath'] : undefined
    if (!workspace) {
      evidence.push(`local-container ${environment.id} has no workspace metadata`)
      continue
    }
    if (environment.status === 'cleanup_failed' && isLocalContainerWorkspace(workspace)) {
      try {
        fs.rmSync(path.dirname(workspace), { recursive: true, force: true })
        evidence.push(`local-container ${environment.id} stale workspace cleanup attempted`)
      } catch (err: any) {
        evidence.push(`local-container ${environment.id} stale workspace cleanup failed: ${shortText(err?.message || err, 500)}`)
      }
      continue
    }
    evidence.push(fs.existsSync(workspace) ? `local-container ${environment.id} workspace present` : `local-container ${environment.id} workspace missing`)
  }
  return { ...base, evidence }
}


export function createLocalContainerWorkspace(spec: EnvironmentSpec, options: { taskId: string; stage: string; idempotencyKey?: string }): string {
  const keyed = options.idempotencyKey ? localContainerWorkspaceTargetForKey(spec, options.idempotencyKey) : undefined
  const root = keyed?.root || path.join(os.tmpdir(), 'opencode-gateway', 'local-container', `${safePathPart(spec.name)}-${safePathPart(options.taskId)}-${safePathPart(options.stage)}-${randomUUID()}`)
  const workspace = path.join(root, 'workspace')
  if (keyed) fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })
  if (spec.workdir && fs.existsSync(spec.workdir) && fs.statSync(spec.workdir).isDirectory()) fs.cpSync(spec.workdir, workspace, { recursive: true, dereference: false })
  return workspace
}

export function localContainerWorkspaceTargetForKey(spec: EnvironmentSpec, idempotencyKey: string): { idempotencyKeyHash: string; root: string; workspace: string } {
  const idempotencyKeyHash = environmentIdempotencyKeyHash(idempotencyKey)
  const root = path.join(os.tmpdir(), 'opencode-gateway', 'local-container', `${safePathPart(spec.name)}-key-${idempotencyKeyHash}`)
  return { idempotencyKeyHash, root, workspace: path.join(root, 'workspace') }
}

export function createLocalContainerCaptureDir(workspace: string): string {
  const dir = path.join(path.dirname(workspace), 'captures')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function createLocalContainerCommandWrapper(spec: EnvironmentSpec, workdir: string | undefined, captureDir: string): string {
  const scriptPath = path.join(path.dirname(captureDir), 'gateway-container-command.js')
  const runtimePrefix = localContainerCommandPrefix(spec, workdir)
  const timeoutMs = spec.resources.timeoutMs
  const script = `#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const prefix = ${JSON.stringify(runtimePrefix)}
const captureDir = ${JSON.stringify(captureDir)}
const timeoutMs = ${JSON.stringify(timeoutMs)}
fs.mkdirSync(captureDir, { recursive: true })
const command = process.argv.slice(2)
const id = 'cmd-' + Date.now() + '-' + process.pid
const startedAt = new Date().toISOString()
const started = Date.now()
const result = spawnSync(prefix[0], prefix.slice(1).concat(command), { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: timeoutMs })
const completedAt = new Date().toISOString()
const stdout = String(result.stdout || '')
const stderr = String(result.stderr || '')
const exitCode = result.status === null || result.status === undefined ? (result.error && result.error.code === 'ETIMEDOUT' ? 124 : 1) : result.status
const stdoutPath = path.join(captureDir, id + '.stdout.log')
const stderrPath = path.join(captureDir, id + '.stderr.log')
const metadataPath = path.join(captureDir, id + '.json')
fs.writeFileSync(stdoutPath, stdout)
fs.writeFileSync(stderrPath, stderr)
fs.writeFileSync(metadataPath, JSON.stringify({ id, command, runtimeCommand: prefix.concat(command), exitCode, runtimeMs: Date.now() - started, startedAt, completedAt, stdoutPath, stderrPath, error: result.error ? String(result.error.message || result.error) : undefined }, null, 2))
if (stdout) process.stdout.write(stdout)
if (stderr) process.stderr.write(stderr)
process.exit(exitCode)
`
  fs.writeFileSync(scriptPath, script)
  fs.chmodSync(scriptPath, 0o755)
  return scriptPath
}

export function inspectLocalContainerImage(spec: EnvironmentSpec): { status: 'ok' | 'missing' | 'unavailable'; digest?: string; error?: string } {
  const runtime = spec.container?.runtime || 'docker'
  const image = spec.container?.image
  if (!image) return { status: 'missing', error: 'container image is not configured' }
  if (!binaryAvailable(runtime)) return { status: 'unavailable', error: `container runtime not found: ${runtime}` }
  const result = spawnSync(runtime, ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status === 0) return { status: 'ok', digest: shortText(result.stdout.trim() || 'unknown', 300) }
  return { status: 'missing', error: shortText([result.stderr, result.stdout].filter(Boolean).join('\n') || `image inspect exited ${result.status}`, 500) }
}

interface LocalContainerCommandResult {
  ok: boolean
  exitCode?: number
  output: string
  stdout: string
  stderr: string
  runtimeMs: number
  commandRef: string
  phase: string
  error?: string
}

export function preflightLocalContainerStageCommands(spec: EnvironmentSpec, base: EnvironmentPreflightResult): { preflight: EnvironmentPreflightResult; results: LocalContainerCommandResult[] } {
  const checked = base.checked.slice()
  const missing = base.missing.slice()
  const warnings = base.warnings.slice()
  const commandRefs = base.commandRefs.slice()
  const results: LocalContainerCommandResult[] = []
  if (!base.ok) return { preflight: base, results }
  for (const [index, command] of spec.setup.entries()) {
    const result = runLocalContainerShellCommand(spec, command, spec.workdir, `setup:${index + 1}`)
    results.push(result)
    checked.push(`setup:${index + 1}`)
    commandRefs.push(result.commandRef)
    if (!result.ok) {
      missing.push(`setup:${index + 1}`)
      warnings.push(`local-container setup command ${index + 1} failed: ${result.output || result.error || 'no output'}`)
    }
  }
  for (const [index, command] of spec.validation.entries()) {
    const result = runLocalContainerShellCommand(spec, command, spec.workdir, `validation:${index + 1}`)
    results.push(result)
    checked.push(`validation:${index + 1}`)
    commandRefs.push(result.commandRef)
    if (!result.ok) {
      missing.push(`validation:${index + 1}`)
      warnings.push(`local-container validation command ${index + 1} failed: ${result.output || result.error || 'no output'}`)
    }
  }
  return { preflight: { ok: missing.length === 0, checked: uniqueStrings(checked), missing: uniqueStrings(missing), warnings, commandRefs: uniqueStrings(commandRefs) }, results }
}

export function runLocalContainerShellCommand(spec: EnvironmentSpec, command: string, workdir: string | undefined, phase: string): LocalContainerCommandResult {
  return runLocalContainerCommand(spec, ['sh', '-lc', command], workdir, phase)
}

export function runLocalContainerCommand(spec: EnvironmentSpec, command: string[], workdir: string | undefined, phase = 'command'): LocalContainerCommandResult {
  const started = Date.now()
  const runtime = spec.container?.runtime || 'docker'
  const args = localContainerRunArgs(spec, workdir, command)
  const result = spawnSync(runtime, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: spec.resources.timeoutMs })
  const stdout = redactLocalContainerText(String(result.stdout || ''), spec)
  const stderr = redactLocalContainerText(String(result.stderr || ''), spec)
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status === null ? undefined : result.status,
    output: shortText([stdout, stderr].filter(Boolean).join('\n'), 2000),
    stdout: shortText(stdout, 2000),
    stderr: shortText(stderr, 2000),
    runtimeMs: Date.now() - started,
    commandRef: localContainerCommandRef(runtime, args),
    phase,
    error: result.error ? shortText(result.error.message || String(result.error), 500) : undefined,
  }
}

export function localContainerCommandSummary(result: LocalContainerCommandResult): Record<string, unknown> {
  return {
    ok: result.ok,
    phase: result.phase,
    commandRef: result.commandRef,
    exitCode: result.exitCode,
    runtimeMs: result.runtimeMs,
    output: result.ok ? undefined : result.output,
    error: result.error,
  }
}

export function localContainerCommandRef(runtime: string, args: string[]): string {
  return [runtime, ...args].join(' ')
}

export function warmLocalContainerPool(spec: EnvironmentSpec, workdir: string | undefined): { enabled: false } | { enabled: true; key: string; hit: boolean; warmedAt?: string; result?: LocalContainerCommandResult } {
  if (!spec.container?.warm) return { enabled: false }
  const runtime = spec.container.runtime || 'docker'
  const image = spec.container.image || '<image>'
  const key = hashText(`${runtime}\0${image}\0${spec.specHash}`).slice(0, 24)
  const existing = localContainerWarmPools.get(key)
  if (existing) return { enabled: true, key, hit: true, warmedAt: existing.warmedAt }
  const result = runLocalContainerCommand(spec, ['true'], workdir, 'warmup')
  const warmedAt = new Date().toISOString()
  if (result.ok) localContainerWarmPools.set(key, { warmedAt, runtime, image, specHash: spec.specHash })
  return { enabled: true, key, hit: false, warmedAt: result.ok ? warmedAt : undefined, result }
}

export function redactLocalContainerText(text: string, spec: EnvironmentSpec): string {
  let out = text
  for (const name of uniqueStrings([...Object.keys(spec.env), ...spec.secrets.allow])) {
    const value = process.env[name]
    if (value && value.length >= 4) out = out.split(value).join('<redacted>')
  }
  return out
}

export function localContainerCommandPrefix(spec: EnvironmentSpec, workdir: string | undefined): string[] {
  return [spec.container?.runtime || 'docker', ...localContainerRunArgs(spec, workdir, [])]
}

export function localContainerRunArgs(spec: EnvironmentSpec, workdir: string | undefined, command: string[]): string[] {
  const containerWorkdir = localContainerWorkdir(spec)
  const args = ['run', '--rm']
  if (spec.container?.pull && spec.container.pull !== 'missing') args.push('--pull', spec.container.pull)
  if (spec.container?.privileged) args.push('--privileged')
  if (spec.container?.user) args.push('--user', spec.container.user)
  if (spec.resources.cpu) args.push('--cpus', String(spec.resources.cpu))
  if (spec.resources.memory) args.push('--memory', spec.resources.memory)
  args.push(...localContainerNetworkArgs(spec))
  for (const [key, value] of Object.entries(spec.env)) args.push('--env', value === SECRET_VALUE_PLACEHOLDER ? key : `${key}=${value}`)
  for (const mount of spec.container?.mounts || []) args.push('--volume', `${mount.source}:${mount.target}:${mount.readonly ? 'ro' : 'rw'}`)
  for (const volume of localContainerCacheVolumes(spec)) args.push('--volume', `${volume.name}:${volume.target}:${volume.mode === 'readonly' ? 'ro' : 'rw'}`)
  if (workdir) args.push('--volume', `${workdir}:${containerWorkdir}:rw`)
  args.push('--workdir', containerWorkdir)
  if (spec.container?.entrypoint?.length) args.push('--entrypoint', spec.container.entrypoint[0]!)
  args.push(spec.container?.image || '<image>')
  args.push(...(spec.container?.entrypoint?.slice(1) || []), ...command)
  return args
}

function assertContainerNetworkPolicy(spec: Pick<EnvironmentSpec, 'name' | 'network' | 'container'>): void {
  const configuredNetwork = spec.container?.network
  if ((spec.network.mode === 'disabled' || spec.network.mode === 'restricted') && configuredNetwork && configuredNetwork !== 'none') {
    throw new Error(`environment ${spec.name} network.mode=${spec.network.mode} conflicts with container.network=${configuredNetwork}`)
  }
  if (spec.network.mode === 'restricted' && spec.network.allow?.length) {
    throw new Error(`environment ${spec.name} network.mode=restricted with network.allow is unsupported by the Docker-compatible runtime; no allowlist enforcement mechanism is configured`)
  }
}

export function localContainerNetworkArgs(spec: EnvironmentSpec): string[] {
  assertContainerNetworkPolicy(spec)
  if (spec.network.mode === 'disabled' || spec.network.mode === 'restricted') return ['--network', 'none']
  return spec.container?.network ? ['--network', spec.container.network] : []
}

export function localContainerWorkdir(spec: EnvironmentSpec): string {
  return spec.container?.workdir || DEFAULT_CONTAINER_WORKDIR
}

export function localContainerCacheVolumes(spec: EnvironmentSpec): Array<{ name: string; target: string; mode: 'readonly' | 'readwrite' }> {
  return spec.cache.volumes.map(volume => ({ name: `opencode-gateway-${hashText(`${spec.specHash}:${volume.name}`).slice(0, 16)}-${safePathPart(volume.name)}`, target: volume.path, mode: volume.mode || 'readwrite' }))
}

export function readLocalContainerCaptures(captureDir: string | undefined): Array<Record<string, any> & { metadataPath: string }> {
  if (!captureDir || !fs.existsSync(captureDir)) return []
  const rows: Array<Record<string, any> & { metadataPath: string }> = []
  for (const entry of fs.readdirSync(captureDir).sort()) {
    if (!entry.endsWith('.json')) continue
    const metadataPath = path.join(captureDir, entry)
    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) rows.push({ ...(parsed as Record<string, any>), metadataPath })
    } catch {}
  }
  return rows
}

export function localContainerWorkspaceArtifacts(workspace: string | undefined): string[] {
  if (!workspace) return []
  const root = path.join(workspace, '.gateway', 'artifacts')
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return []
  const out: string[] = []
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir).sort()) {
      if (out.length >= 100) return
      const full = path.join(dir, entry)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) out.push(full)
    }
  }
  walk(root)
  return out
}


export function isLocalContainerWorkspace(workspace: string): boolean {
  const root = path.join(os.tmpdir(), 'opencode-gateway', 'local-container')
  const relative = path.relative(root, workspace)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}
