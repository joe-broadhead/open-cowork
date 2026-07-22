/**
 * Remote Crabbox environment backend (JOE-936 / JOE-919).
 * Leaf module — no import from environments.ts.
 */
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { stableStringifyDefined } from '../stable-stringify.js'
import type {
  EnvironmentAcquisitionLookupResult,
  EnvironmentAcquisitionReleaseResult,
  EnvironmentPreflightResult,
  EnvironmentPrepareOptions,
  EnvironmentReconciliationResult,
  EnvironmentRunRecord,
  EnvironmentSpec,
} from './types.js'
import {
  SECRET_NAME_PATTERN,
  SECRET_VALUE_PLACEHOLDER,
  binaryAvailable,
  environmentIdempotencyKeyHash,
  normalizeEnvironmentIdempotencyKey,
  redactEnvironmentRecord,
  remoteCrabboxAcquisitionSlug,
  shortText,
  uniqueStrings,
} from './util.js'
import {
  reconcileEnvironmentRuns,
  releaseEnvironmentRun,
} from './lifecycle.js'

let prepareEnvironmentFn: ((spec: EnvironmentSpec, options?: EnvironmentPrepareOptions) => EnvironmentRunRecord) | undefined
export function setCrabboxPrepareEnvironment(fn: NonNullable<typeof prepareEnvironmentFn>): void {
  prepareEnvironmentFn = fn
}
function prepareEnvironment(spec: EnvironmentSpec, options?: EnvironmentPrepareOptions): EnvironmentRunRecord {
  if (!prepareEnvironmentFn) throw new Error('crabbox prepareEnvironment not configured')
  return prepareEnvironmentFn(spec, options)
}

export function prepareRemoteCrabboxEnvironment(spec: EnvironmentSpec, options: EnvironmentPrepareOptions = { taskId: 'unknown', stage: 'unknown' }): EnvironmentRunRecord {
  const base = prepareEnvironment(spec, options)
  if (!base.preflight.ok) return { ...base, leaseId: undefined }

  const idempotencyKey = options.idempotencyKey ? normalizeEnvironmentIdempotencyKey(options.idempotencyKey) : undefined
  const requestedSlug = idempotencyKey ? remoteCrabboxAcquisitionSlug(idempotencyKey) : undefined
  let existing = idempotencyKey ? lookupRemoteCrabboxEnvironmentByKey(spec, idempotencyKey) : undefined
  if (existing && !existing.ok) throw new Error(`Crabbox acquisition lookup failed: ${existing.reason || existing.evidence.join('; ')}`)

  let warmup: CrabboxCommandResult | undefined
  let duplicateLeaseReleased: string | undefined
  let leaseId = existing?.found ? existing.resourceId : undefined
  if (!leaseId) {
    warmup = runCrabboxCli(spec, crabboxWarmupArgs(spec, idempotencyKey), 'warmup')
    if (!warmup.ok) throw new Error(`Crabbox lease failed (${warmup.failureClass}): ${warmup.output || warmup.error || 'warmup failed'}`)
    leaseId = crabboxLeaseId(warmup)
    if (leaseId && idempotencyKey) {
      const keyedLease = lookupRemoteCrabboxEnvironmentByKey(spec, idempotencyKey)
      if (!keyedLease.ok || !keyedLease.found || !keyedLease.resourceId) {
        const cleanup = releaseRemoteCrabboxLease(spec, leaseId)
        const cleanupFailure = cleanup.ok ? '' : `; duplicate cleanup failed: ${cleanup.output || cleanup.error || 'unknown failure'}`
        throw new Error(`Crabbox keyed lease could not be resolved after warmup: ${keyedLease.reason || keyedLease.evidence.join('; ')}${cleanupFailure}`)
      }
      if (keyedLease.resourceId !== leaseId) {
        const cleanup = releaseRemoteCrabboxLease(spec, leaseId)
        if (!cleanup.ok) throw new Error(`Crabbox duplicate lease cleanup failed (${cleanup.failureClass}): ${cleanup.output || cleanup.error || 'release failed'}`)
        duplicateLeaseReleased = leaseId
        leaseId = keyedLease.resourceId
        existing = keyedLease
      }
    }
  }
  if (!leaseId) throw new Error('Crabbox lease failed (unknown): warmup did not return a lease id')
  const slug = (warmup ? crabboxSlug(warmup) : undefined) || stringField(existing?.metadata, 'slug') || requestedSlug
  const inspect = inspectRemoteCrabboxLease(spec, leaseId)
  const remotePreflight = preflightRemoteCrabboxLease(spec, leaseId, base.preflight)
  const timing = [warmup?.timing, ...remotePreflight.results.map(result => result.timing)].filter(Boolean)
  const runIds = remotePreflight.results.map(crabboxRunId).filter(Boolean)
  const artifacts = uniqueStrings(remotePreflight.results.flatMap(result => result.artifacts))
  const inspectRecord = inspect.ok ? inspect.record : undefined
  const provider = stringField(inspectRecord, 'provider') || stringField(warmup?.timing, 'provider') || spec.crabbox?.provider
  const machineClass = spec.crabbox?.class || stringField(inspectRecord, 'class') || stringField(inspectRecord, 'type') || stringField(warmup?.timing, 'class')
  const remoteWorkdir = stringField(inspectRecord, 'remoteWorkdir') || stringField(inspectRecord, 'remote_workdir') || stringField(inspectRecord, 'workroot') || stringField(warmup?.timing, 'remoteWorkdir') || stringField(warmup?.timing, 'remote_workdir')
  return {
    ...base,
    status: remotePreflight.preflight.ok ? 'prepared' : 'blocked',
    provider,
    class: machineClass,
    leaseId,
    runId: runIds.at(-1),
    preflight: remotePreflight.preflight,
    artifacts,
    cleanup: { ...base.cleanup, retainOnFailure: base.cleanup.retainOnFailure || spec.crabbox?.keepOnFailure === true },
    metadata: {
      ...base.metadata,
      leaseId,
      slug,
      inspect: inspectRecord,
      inspectStatus: inspect.ok ? 'ok' : 'failed',
      inspectError: inspect.ok ? undefined : inspect.reason,
      timing,
      acquisitionKeyHash: idempotencyKey ? environmentIdempotencyKeyHash(idempotencyKey) : undefined,
      acquisitionSlug: requestedSlug,
      acquisitionReused: existing?.found === true,
      acquisitionDuplicateReleased: duplicateLeaseReleased,
      commandPrefix: remoteCrabboxCommandPrefix(spec, { ...base, leaseId }),
      commandResults: remotePreflight.results.map(crabboxCommandSummary),
      remoteWorkdir,
    },
  }
}

export function preflightRemoteCrabboxLease(spec: EnvironmentSpec, leaseId: string, base: EnvironmentPreflightResult): { preflight: EnvironmentPreflightResult; results: CrabboxCommandResult[] } {
  const checked = base.checked.slice()
  const missing = base.missing.slice()
  const warnings = base.warnings.slice()
  const commandRefs = base.commandRefs.slice()
  const results: CrabboxCommandResult[] = []
  checked.push(`lease:${leaseId}`)
  for (const tool of spec.tools) {
    const result = runCrabboxRemoteCommand(spec, leaseId, `tool:${tool}`, ['command', '-v', tool])
    results.push(result)
    checked.push(tool)
    commandRefs.push(result.commandRef)
    if (!result.ok) {
      missing.push(tool)
      warnings.push(`remote-crabbox tool check failed for ${tool} (${result.failureClass}): ${result.output || 'no output'}`)
    }
  }
  for (const [index, command] of spec.setup.entries()) {
    const result = runCrabboxRemoteCommand(spec, leaseId, `setup:${index + 1}`, command)
    results.push(result)
    checked.push(`setup:${index + 1}`)
    commandRefs.push(result.commandRef)
    if (!result.ok) {
      missing.push(`setup:${index + 1}`)
      warnings.push(`remote-crabbox setup command ${index + 1} failed (${result.failureClass}): ${result.output || 'no output'}`)
    }
  }
  for (const [index, command] of spec.validation.entries()) {
    const result = runCrabboxRemoteCommand(spec, leaseId, `validation:${index + 1}`, command)
    results.push(result)
    checked.push(`validation:${index + 1}`)
    commandRefs.push(result.commandRef)
    if (!result.ok) {
      missing.push(`validation:${index + 1}`)
      warnings.push(`remote-crabbox validation command ${index + 1} failed (${result.failureClass}): ${result.output || 'no output'}`)
    }
  }
  return { preflight: { ok: missing.length === 0, checked: uniqueStrings(checked), missing: uniqueStrings(missing), warnings, commandRefs: uniqueStrings(commandRefs) }, results }
}

export function releaseRemoteCrabboxEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  const leaseId = environment.leaseId
  if (!leaseId) return releaseEnvironmentRun(environment)
  const cli = typeof environment.runtime === 'string' ? environment.runtime : 'crabbox'
  const provider = typeof environment.provider === 'string' ? environment.provider : undefined
  const result = runCrabboxReleaseCommand(cli, provider, leaseId, 'stop')
  if (!result.ok && isUnknownCrabboxCommand(result.output)) {
    const fallback = runCrabboxReleaseCommand(cli, provider, leaseId, 'release')
    if (!fallback.ok) throw new Error(`Crabbox release failed (${fallback.failureClass}): ${fallback.output || fallback.error || 'release failed'}`)
  } else if (!result.ok) {
    throw new Error(`Crabbox stop failed (${result.failureClass}): ${result.output || result.error || 'stop failed'}`)
  }
  return releaseEnvironmentRun({ ...environment, metadata: { ...environment.metadata, releasedLeaseId: leaseId } })
}


export function lookupRemoteCrabboxEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
  const key = normalizeEnvironmentIdempotencyKey(idempotencyKey)
  const idempotencyKeyHash = environmentIdempotencyKeyHash(key)
  const slug = remoteCrabboxAcquisitionSlug(key)
  const inspect = inspectRemoteCrabboxLease(spec, slug)
  if (!inspect.ok) {
    const missing = isMissingCrabboxLease(inspect.reason)
    return {
      ok: missing,
      found: false,
      backend: spec.backend,
      idempotencyKeyHash,
      metadata: { slug },
      evidence: [missing ? `remote-crabbox acquisition ${idempotencyKeyHash} was not found` : `remote-crabbox acquisition lookup failed: ${shortText(inspect.reason, 500)}`],
      reason: missing ? undefined : inspect.reason,
    }
  }
  const resourceId = crabboxLeaseIdFromRecord(inspect.record)
  if (!resourceId) {
    return {
      ok: false,
      found: false,
      backend: spec.backend,
      idempotencyKeyHash,
      metadata: { slug },
      evidence: [`remote-crabbox acquisition lookup returned no canonical lease id`],
      reason: 'Crabbox inspect returned no canonical lease id',
    }
  }
  return {
    ok: true,
    found: true,
    backend: spec.backend,
    idempotencyKeyHash,
    resourceId,
    provider: stringField(inspect.record, 'provider') || spec.crabbox?.provider,
    state: stringField(inspect.record, 'state') || stringField(inspect.record, 'status'),
    metadata: { ...inspect.record, slug: stringField(inspect.record, 'slug') || slug },
    evidence: [`remote-crabbox acquisition ${idempotencyKeyHash} resolved to lease ${resourceId}`],
  }
}

export function releaseRemoteCrabboxEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
  const lookup = lookupRemoteCrabboxEnvironmentByKey(spec, idempotencyKey)
  if (!lookup.ok || !lookup.found || !lookup.resourceId) {
    return {
      ok: lookup.ok,
      found: lookup.found,
      released: false,
      backend: spec.backend,
      idempotencyKeyHash: lookup.idempotencyKeyHash,
      resourceId: lookup.resourceId,
      evidence: lookup.evidence,
      reason: lookup.reason,
    }
  }
  const release = releaseRemoteCrabboxLease(spec, lookup.resourceId)
  return {
    ok: release.ok,
    found: true,
    released: release.ok,
    backend: spec.backend,
    idempotencyKeyHash: lookup.idempotencyKeyHash,
    resourceId: lookup.resourceId,
    evidence: [...lookup.evidence, release.ok ? `remote-crabbox lease ${lookup.resourceId} released by acquisition key` : `remote-crabbox lease ${lookup.resourceId} release failed: ${release.output || release.error || 'unknown failure'}`],
    reason: release.ok ? undefined : release.output || release.error || 'Crabbox release failed',
  }
}

export function releaseRemoteCrabboxLease(spec: EnvironmentSpec, leaseId: string): CrabboxCommandResult {
  let release = runCrabboxCli(spec, crabboxReleaseArgs(spec, leaseId, 'stop'), 'release')
  if (!release.ok && isUnknownCrabboxCommand(release.output)) {
    release = runCrabboxCli(spec, crabboxReleaseArgs(spec, leaseId, 'release'), 'release')
  }
  return release
}

interface CrabboxCommandResult {
  ok: boolean
  exitCode?: number
  output: string
  stdout: string
  stderr: string
  runtimeMs: number
  timing?: Record<string, unknown>
  artifacts: string[]
  commandRef: string
  failureClass: 'capacity' | 'auth' | 'quota' | 'setup' | 'sync' | 'command' | 'timeout' | 'network' | 'unknown'
  error?: string
}

export function runCrabboxRemoteCommand(spec: EnvironmentSpec, leaseId: string, phase: string, command: string | string[]): CrabboxCommandResult {
  const args = crabboxRunArgs(spec, leaseId)
  if (Array.isArray(command)) args.push('--', ...command)
  else args.push('--shell', command)
  return runCrabboxCli(spec, args, phase)
}

export function runCrabboxCli(spec: EnvironmentSpec, args: string[], phase: string): CrabboxCommandResult {
  const started = Date.now()
  const cli = spec.crabbox?.cli || 'crabbox'
  const result = spawnSync(cli, args, {
    cwd: spec.workdir && fs.existsSync(spec.workdir) ? spec.workdir : undefined,
    env: crabboxProcessEnv(spec),
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: spec.resources.timeoutMs,
  })
  const stdout = redactCrabboxText(String(result.stdout || ''), spec)
  const stderr = redactCrabboxText(String(result.stderr || ''), spec)
  const output = shortText([stdout, stderr].filter(Boolean).join('\n'), 2000)
  const timing = crabboxTimingRecord(stderr)
  const timedOut = (result.error as any)?.code === 'ETIMEDOUT'
  const failureClass = classifyCrabboxFailure(output || String(result.error || ''), phase, timing, timedOut)
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status === null ? undefined : result.status,
    output,
    stdout: shortText(stdout, 2000),
    stderr: shortText(stderr, 2000),
    runtimeMs: Date.now() - started,
    timing,
    artifacts: crabboxArtifacts(timing),
    commandRef: crabboxCommandRef(cli, args),
    failureClass,
    error: result.error ? shortText(result.error.message || String(result.error), 500) : undefined,
  }
}

export function runCrabboxReleaseCommand(cli: string, provider: string | undefined, leaseId: string, command: 'stop' | 'release'): CrabboxCommandResult {
  const args: string[] = [command]
  if (provider) args.push('--provider', provider)
  args.push(leaseId)
  const started = Date.now()
  const result = spawnSync(cli, args, { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000 })
  const output = shortText([result.stdout, result.stderr].filter(Boolean).join('\n'), 2000)
  const timedOut = (result.error as any)?.code === 'ETIMEDOUT'
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status === null ? undefined : result.status,
    output,
    stdout: shortText(result.stdout || '', 2000),
    stderr: shortText(result.stderr || '', 2000),
    runtimeMs: Date.now() - started,
    artifacts: [],
    commandRef: crabboxCommandRef(cli, args),
    failureClass: classifyCrabboxFailure(output || String(result.error || ''), 'release', undefined, timedOut),
    error: result.error ? shortText(result.error.message || String(result.error), 500) : undefined,
  }
}

export function inspectRemoteCrabboxLease(spec: EnvironmentSpec, leaseId: string): { ok: true; record: Record<string, unknown> } | { ok: false; reason: string } {
  const args = ['inspect', '--id', leaseId, '--json']
  if (spec.crabbox?.provider) args.splice(1, 0, '--provider', spec.crabbox.provider)
  const result = runCrabboxCli(spec, args, 'inspect')
  if (!result.ok) return { ok: false, reason: result.output || result.error || 'inspect failed' }
  try {
    const parsed = JSON.parse(result.stdout || result.output || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ok: true, record: redactEnvironmentRecord(parsed as Record<string, unknown>) } : { ok: false, reason: 'inspect returned non-object JSON' }
  } catch (err: any) {
    return { ok: false, reason: `inspect returned invalid JSON: ${err?.message || err}` }
  }
}

export function reconcileRemoteCrabboxEnvironmentRuns(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult {
  const base = reconcileEnvironmentRuns(environments)
  const evidence = base.evidence.slice()
  for (const environment of environments.filter(row => row.backend === 'remote-crabbox' && (row.status === 'prepared' || row.status === 'retained'))) {
    const leaseId = environment.leaseId
    const cli = typeof environment.runtime === 'string' ? environment.runtime : 'crabbox'
    if (!leaseId) {
      evidence.push(`remote-crabbox ${environment.id} has no lease id`)
      continue
    }
    if (!binaryAvailable(cli)) {
      evidence.push(`remote-crabbox ${leaseId} inspect skipped: ${cli} unavailable`)
      continue
    }
    const result = spawnSync(cli, ['inspect', '--id', leaseId, '--json'], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 60_000 })
    evidence.push(result.status === 0 ? `remote-crabbox ${leaseId} inspect ok` : `remote-crabbox ${leaseId} inspect failed: ${shortText([result.stderr, result.stdout].filter(Boolean).join('\n') || result.error?.message || 'unknown', 500)}`)
  }
  return { ...base, evidence }
}

export function crabboxWarmupArgs(spec: EnvironmentSpec, idempotencyKey?: string): string[] {
  const args = ['warmup', '--timing-json']
  if (idempotencyKey) args.push('--slug', remoteCrabboxAcquisitionSlug(idempotencyKey))
  if (spec.crabbox?.profile) args.push('--profile', spec.crabbox.profile)
  if (spec.crabbox?.provider) args.push('--provider', spec.crabbox.provider)
  if (spec.crabbox?.class) args.push('--class', spec.crabbox.class)
  if (spec.crabbox?.ttl) args.push('--ttl', spec.crabbox.ttl)
  for (const volume of spec.cache.volumes) args.push('--cache-volume', `${volume.name}:${volume.path}`)
  return args
}

export function crabboxReleaseArgs(spec: EnvironmentSpec, leaseId: string, command: 'stop' | 'release'): string[] {
  const args: string[] = [command]
  if (spec.crabbox?.provider) args.push('--provider', spec.crabbox.provider)
  args.push(leaseId)
  return args
}

export function crabboxRunArgs(spec: EnvironmentSpec, leaseId: string): string[] {
  const args = ['run', '--id', leaseId, '--timing-json']
  if (spec.crabbox?.provider) args.push('--provider', spec.crabbox.provider)
  if (spec.crabbox?.keepOnFailure) args.push('--keep-on-failure')
  for (const name of crabboxAllowedEnvNames(spec)) args.push('--allow-env', name)
  return args
}

export function remoteCrabboxCommandPrefix(spec: EnvironmentSpec, environment: Pick<EnvironmentRunRecord, 'leaseId'>): string[] {
  const leaseId = environment.leaseId || '<lease-id>'
  return [spec.crabbox?.cli || 'crabbox', ...crabboxRunArgs(spec, leaseId), '--']
}

export function crabboxProcessEnv(spec: EnvironmentSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['PATH', 'HOME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  if (spec.crabbox?.brokerUrl) env['CRABBOX_COORDINATOR'] = spec.crabbox.brokerUrl
  for (const name of crabboxAllowedEnvNames(spec)) {
    if (process.env[name]) env[name] = process.env[name]
  }
  for (const [key, value] of Object.entries(spec.env)) {
    if (value !== SECRET_VALUE_PLACEHOLDER) env[key] = value
  }
  return env
}

export function crabboxAllowedEnvNames(spec: EnvironmentSpec): string[] {
  return uniqueStrings([...Object.keys(spec.env), ...spec.secrets.allow])
}

export function redactCrabboxText(text: string, spec: EnvironmentSpec): string {
  let out = text
  for (const name of crabboxAllowedEnvNames(spec)) {
    if (!SECRET_NAME_PATTERN.test(name) && !spec.secrets.allow.includes(name)) continue
    const value = process.env[name]
    if (value && value.length >= 4) out = out.split(value).join('<redacted>')
  }
  return out
}

export function crabboxTimingRecord(output: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith('{') || !text.endsWith('}')) continue
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) found = redactEnvironmentRecord(parsed as Record<string, unknown>)
    } catch {}
  }
  return found
}

export function crabboxLeaseId(result: CrabboxCommandResult): string | undefined {
  return stringField(result.timing, 'leaseId') || stringField(result.timing, 'lease_id') || result.stdout.match(/\b(cbx_[a-zA-Z0-9_-]+)/)?.[1] || result.output.match(/\b(cbx_[a-zA-Z0-9_-]+)/)?.[1]
}

export function crabboxLeaseIdFromRecord(record: Record<string, unknown>): string | undefined {
  return stringField(record, 'id') || stringField(record, 'leaseId') || stringField(record, 'lease_id')
}

export function crabboxSlug(result: CrabboxCommandResult): string | undefined {
  return stringField(result.timing, 'slug') || result.stdout.match(/\bslug=([^\s]+)/)?.[1] || result.output.match(/\bslug=([^\s]+)/)?.[1]
}

export function crabboxRunId(result: CrabboxCommandResult): string | undefined {
  return stringField(result.timing, 'runId') || stringField(result.timing, 'run_id')
}

export function crabboxArtifacts(timing: Record<string, unknown> | undefined): string[] {
  if (!timing) return []
  const values = [timing['artifacts'], timing['artifactRefs'], timing['artifact_refs'], timing['captures'], timing['downloads']]
  const refs: string[] = []
  for (const value of values) {
    if (Array.isArray(value)) refs.push(...value.map(item => typeof item === 'string' ? item : stableStringifyDefined(item)))
    else if (typeof value === 'string') refs.push(value)
  }
  return uniqueStrings(refs.map(ref => shortText(ref, 500)))
}

export function crabboxCommandSummary(result: CrabboxCommandResult): Record<string, unknown> {
  return {
    ok: result.ok,
    commandRef: result.commandRef,
    exitCode: result.exitCode,
    runtimeMs: result.runtimeMs,
    failureClass: result.ok ? undefined : result.failureClass,
    output: result.ok ? undefined : result.output,
    runId: crabboxRunId(result),
    artifacts: result.artifacts,
  }
}

export function crabboxCommandRef(cli: string, args: string[]): string {
  return [cli, ...args].join(' ')
}

export function classifyCrabboxFailure(output: string, phase: string, timing: Record<string, unknown> | undefined, timedOut = false): CrabboxCommandResult['failureClass'] {
  const text = `${output} ${stringField(timing, 'blockedStage') || ''} ${stringField(timing, 'failureClass') || ''}`.toLowerCase()
  if (timedOut || /\b(timeout|timed out|deadline)\b/.test(text)) return 'timeout'
  if (/\b(auth|unauthorized|forbidden|login|credential|credentials|token|api key|permission denied)\b/.test(text)) return 'auth'
  if (/\b(quota|budget|billing|insufficient|limit exceeded|rate limit)\b/.test(text)) return 'quota'
  if (/\b(capacity|no capacity|sold out|exhausted|unavailable capacity)\b/.test(text)) return 'capacity'
  if (/\b(sync|rsync|checkout|manifest|mass deletion|mass deletions)\b/.test(text)) return 'sync'
  if (/\b(network|ssh|connect|connection|econn|dns|host unreachable|no route)\b/.test(text)) return 'network'
  if (phase.startsWith('setup') || text.includes('install/setup')) return 'setup'
  if (phase !== 'warmup' && phase !== 'inspect' && phase !== 'release') return 'command'
  return 'unknown'
}

export function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

export function isUnknownCrabboxCommand(output: string): boolean {
  return /unknown command|unrecognized command|not a crabbox command/i.test(output)
}

export function isMissingCrabboxLease(output: string): boolean {
  return /\b(not found|no such|unknown lease|missing lease|does not exist|404)\b/i.test(output)
}
