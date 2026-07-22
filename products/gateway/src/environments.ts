import * as fs from 'node:fs'
import { stableStringifyDefined } from './stable-stringify.js'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

export * from './environments/types.js'

import {
  DEFAULT_ENVIRONMENT_NAME,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TTL_MS,
  REMOTE_HOST_PROCESS_CONTROL_ENV_PATTERN,
  SECRET_NAME_PATTERN,
  SECRET_VALUE_PLACEHOLDER,
  binaryAvailable,
  boundedInteger,
  boundedNumber,
  durationMs,
  environmentIdempotencyKeyHash,
  normalizeEnvironmentIdempotencyKey,
  normalizeRuntimeExecutable,
  optionalText,
  redactEnvironmentRecord,
  shortText,
  uniqueStrings,
} from './environments/util.js'
export {
  redactEnvironmentRecord,
  redactEnvironmentSensitiveText,
  redactEnvironmentNetworkTarget,
  redactEnvironmentNetworkTargets,
  remoteCrabboxAcquisitionSlug,
} from './environments/util.js'
import {
  lookupMetadataEnvironmentAcquisition,
  reconcileEnvironmentRuns,
  releaseEnvironmentRun,
  releaseMetadataEnvironmentAcquisition,
  retainEnvironmentRun,
  setEnvironmentControllerResolver,
} from './environments/lifecycle.js'
export {
  cleanupFailedEnvironmentRun,
  environmentPromptContext,
  finalizeEnvironmentRun,
  releaseEnvironmentRun,
  retainEnvironmentRun,
} from './environments/lifecycle.js'
import {
  collectLocalContainerArtifacts,
  inspectLocalContainerImage,
  localContainerCommandPrefix,
  lookupLocalContainerEnvironmentByKey,
  prepareLocalContainerEnvironment,
  reconcileLocalContainerEnvironmentRuns,
  releaseLocalContainerEnvironmentByKey,
  releaseLocalContainerEnvironmentRun,
  runLocalContainerCommand,
  setLocalContainerPrepareEnvironment,
} from './environments/local-container.js'
export { clearLocalContainerWarmPoolsForTest } from './environments/local-container.js'
import {
  lookupRemoteCrabboxEnvironmentByKey,
  prepareRemoteCrabboxEnvironment,
  reconcileRemoteCrabboxEnvironmentRuns,
  releaseRemoteCrabboxEnvironmentByKey,
  releaseRemoteCrabboxEnvironmentRun,
  remoteCrabboxCommandPrefix,
  setCrabboxPrepareEnvironment,
} from './environments/remote-crabbox.js'
import type {
  CrabboxSpec,
  EnvironmentAcquisitionLookupResult,
  EnvironmentAcquisitionReleaseResult,
  EnvironmentBackend,
  EnvironmentCachePolicy,
  EnvironmentCleanupPolicy,
  EnvironmentController,
  EnvironmentHydrationResult,
  EnvironmentNetwork,
  EnvironmentPreflightResult,
  EnvironmentPrepareOptions,
  EnvironmentResolution,
  EnvironmentResolutionInput,
  EnvironmentResources,
  EnvironmentRunRecord,
  EnvironmentSecretPolicy,
  EnvironmentSelector,
  EnvironmentSourceHydrationSummary,
  EnvironmentSourcePlan,
  EnvironmentSpec,
  EnvironmentSpecInput,
  GatewayEnvironmentConfig,
  LocalContainerSpec,
} from './environments/types.js'



export function defaultGatewayEnvironmentConfig(): GatewayEnvironmentConfig {
  return {
    defaultEnvironment: DEFAULT_ENVIRONMENT_NAME,
    maxConcurrent: 20,
    maxRetained: 10,
    backendMaxConcurrent: {},
    requireApprovalForRemote: true,
    requireApprovalForPrivilegedContainer: true,
    environments: {
      [DEFAULT_ENVIRONMENT_NAME]: { backend: 'local-process' },
    },
  }
}

export const localProcessEnvironmentController: EnvironmentController = {
  backend: 'local-process',
  resolve: resolveEnvironmentSpec,
  prepare: prepareEnvironment,
  preflight: preflightEnvironment,
  hydrate(spec, input) {
    const source = hydrateSourcePlan(input.sourcePlan, input.workdir || spec.workdir)
    if (source) {
      return {
        ...source,
        evidence: [...source.evidence, `local-process uses existing workdir${input.workdir || spec.workdir ? `: ${input.workdir || spec.workdir}` : ''}`],
      }
    }
    return {
      ok: true,
      status: 'not_required',
      evidence: [`local-process uses existing workdir${input.workdir || spec.workdir ? `: ${input.workdir || spec.workdir}` : ''}`],
    }
  },
  attach(spec, environment) {
    return { ok: true, workdir: environment.workdir || spec.workdir, commandPrefix: [], evidence: ['local-process attaches OpenCode to the resolved workdir'] }
  },
  collectArtifacts(environment) {
    return { ok: true, artifacts: environment.artifacts.slice(), evidence: environment.artifacts.length ? ['local-process artifact refs collected from run metadata'] : ['local-process has no environment-managed artifacts'] }
  },
  release: releaseEnvironmentRun,
  retain: retainEnvironmentRun,
  cleanup: releaseEnvironmentRun,
  reconcile: reconcileEnvironmentRuns,
  lookupByKey: lookupMetadataEnvironmentAcquisition,
  releaseByKey: releaseMetadataEnvironmentAcquisition,
}

export const localContainerEnvironmentController: EnvironmentController = {
  ...localProcessEnvironmentController,
  backend: 'local-container',
  hydrate(spec, input) {
    const sourcePlan = input.sourcePlan
    const target = input.workdir || spec.workdir
    const sourceWorkdir = sourcePlan?.workdir || spec.workdir
    if (sourcePlan?.missing.length) {
      return hydrateSourcePlan(sourcePlan, target)
        || { ok: false, status: 'failed', reason: 'Dependency source hydration failed before local-container workspace preparation', evidence: ['local-container source hydration failed before workspace preparation'], artifacts: [], source: sourceHydrationSummary(sourcePlan, 'failed') }
    }
    if (sourcePlan?.required && target && sourceWorkdir && path.resolve(target) === path.resolve(sourceWorkdir)) {
      return {
        ok: true,
        status: 'not_required',
        evidence: ['local-container defers dependency source hydration until the isolated workspace is prepared'],
        artifacts: sourcePlan.patches.map(patch => patch.id),
        source: sourceHydrationSummary(sourcePlan, 'not_required'),
      }
    }
    const source = hydrateSourcePlan(sourcePlan, target)
    if (source) {
      return {
        ...source,
        evidence: [...source.evidence, `local-container applied dependency source hydration in isolated workspace${target ? `: ${target}` : ''}`],
      }
    }
    return {
      ok: true,
      status: 'not_required',
      evidence: [`local-container uses isolated workspace${target ? `: ${target}` : ''}`],
    }
  },
  prepare: prepareLocalContainerEnvironment,
  attach(_spec, environment) {
    const commandPrefix = Array.isArray(environment.metadata['commandPrefix']) ? environment.metadata['commandPrefix'].map(String) : []
    return { ok: true, workdir: environment.workdir, commandPrefix, evidence: [`local-container attaches OpenCode to isolated workspace ${environment.workdir || '(none)'}`] }
  },
  collectArtifacts: collectLocalContainerArtifacts,
  release: releaseLocalContainerEnvironmentRun,
  cleanup: releaseLocalContainerEnvironmentRun,
  reconcile: reconcileLocalContainerEnvironmentRuns,
  lookupByKey: lookupLocalContainerEnvironmentByKey,
  releaseByKey: releaseLocalContainerEnvironmentByKey,
}

export const remoteCrabboxEnvironmentController: EnvironmentController = {
  ...localProcessEnvironmentController,
  backend: 'remote-crabbox',
  prepare: prepareRemoteCrabboxEnvironment,
  attach(spec, environment) {
    const commandPrefix = remoteCrabboxCommandPrefix(spec, environment)
    return { ok: true, workdir: environment.workdir || spec.workdir, commandPrefix, evidence: [`remote-crabbox attaches OpenCode to Crabbox lease ${environment.leaseId || '(not leased)'}`] }
  },
  collectArtifacts(environment) {
    return {
      ok: true,
      artifacts: environment.artifacts.slice(),
      evidence: environment.artifacts.length ? ['remote-crabbox artifact refs collected from Crabbox timing JSON'] : ['remote-crabbox has no backend-managed artifact refs'],
    }
  },
  release: releaseRemoteCrabboxEnvironmentRun,
  cleanup: releaseRemoteCrabboxEnvironmentRun,
  reconcile: reconcileRemoteCrabboxEnvironmentRuns,
  lookupByKey: lookupRemoteCrabboxEnvironmentByKey,
  releaseByKey: releaseRemoteCrabboxEnvironmentByKey,
}

const metadataEnvironmentController: EnvironmentController = {
  ...localProcessEnvironmentController,
  backend: 'metadata',
  hydrate(spec, input) {
    const source = hydrateSourcePlan(input.sourcePlan, input.workdir || spec.workdir)
    if (source) {
      return {
        ...source,
        evidence: [...source.evidence, `${spec.backend} hydration uses the shared dependency source plan for task ${input.taskId}`],
      }
    }
    return {
      ok: true,
      status: 'not_required',
      evidence: [`${spec.backend} hydration is delegated to backend adapter metadata for task ${input.taskId}`],
    }
  },
  attach(spec, environment) {
    return { ok: true, workdir: environment.workdir || spec.workdir, commandPrefix: [], evidence: [`${spec.backend} attachment metadata recorded; OpenCode remains the stage runtime`] }
  },
}

const controllerOverrides = new Map<EnvironmentBackend, EnvironmentController>()

export function environmentControllerForSpec(spec: EnvironmentSpec): EnvironmentController {
  return environmentControllerForBackend(spec.backend)
}

export function environmentControllerForBackend(backend: EnvironmentBackend): EnvironmentController {
  return controllerOverrides.get(backend) || (backend === 'local-process' ? localProcessEnvironmentController : backend === 'local-container' ? localContainerEnvironmentController : backend === 'remote-crabbox' ? remoteCrabboxEnvironmentController : metadataEnvironmentController)
}

export function lookupEnvironmentByIdempotencyKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
  return environmentControllerForSpec(spec).lookupByKey(spec, normalizeEnvironmentIdempotencyKey(idempotencyKey))
}

export function releaseEnvironmentByIdempotencyKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
  return environmentControllerForSpec(spec).releaseByKey(spec, normalizeEnvironmentIdempotencyKey(idempotencyKey))
}

export function registerEnvironmentControllerForTest(backend: EnvironmentBackend, controller: EnvironmentController): () => void {
  controllerOverrides.set(backend, controller)
  return () => controllerOverrides.delete(backend)
}

setEnvironmentControllerResolver(environmentControllerForBackend)
setLocalContainerPrepareEnvironment(prepareEnvironment)
setCrabboxPrepareEnvironment(prepareEnvironment)


export function normalizeGatewayEnvironmentConfig(input?: Partial<GatewayEnvironmentConfig> | Record<string, unknown>): GatewayEnvironmentConfig {
  const defaults = defaultGatewayEnvironmentConfig()
  const raw = (input || {}) as any
  const environments = normalizeEnvironmentRegistry({ ...defaults.environments, ...(raw.environments || {}) })
  const defaultEnvironment = normalizeEnvironmentName(raw.defaultEnvironment || raw.default || defaults.defaultEnvironment, 'environments.defaultEnvironment')
  if (!environments[defaultEnvironment]) throw new Error(`environments.defaultEnvironment references missing environment: ${defaultEnvironment}`)
  return {
    defaultEnvironment,
    maxConcurrent: boundedInteger(raw.maxConcurrent ?? defaults.maxConcurrent, 1, 500, 'environments.maxConcurrent'),
    maxRetained: boundedInteger(raw.maxRetained ?? defaults.maxRetained, 0, 500, 'environments.maxRetained'),
    backendMaxConcurrent: normalizeBackendMaxConcurrent(raw.backendMaxConcurrent || defaults.backendMaxConcurrent),
    requireApprovalForRemote: raw.requireApprovalForRemote !== false,
    requireApprovalForPrivilegedContainer: raw.requireApprovalForPrivilegedContainer !== false,
    environments,
  }
}

export function normalizeEnvironmentSelector(value: unknown, label: string): EnvironmentSelector | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return normalizeEnvironmentName(value, label)
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an environment name or object`)
  return sanitizeSpecInput(value as Record<string, unknown>, label)
}

export function resolveEnvironmentSpec(input: EnvironmentResolutionInput): EnvironmentResolution {
  const source: string[] = []
  try {
    const requestedWorkdir = input.workdir ? canonicalEnvironmentPath(input.workdir) : undefined
    if (requestedWorkdir) assertSafeEnvironmentWorkdir(requestedWorkdir, 'task checkout')
    const repo = loadRepoEnvironmentConfig(requestedWorkdir)
    const administratorRegistry = resolveEnvironmentRegistry(input.config.environments, 'administrator')
    const repositoryRegistry = resolveRepositoryEnvironmentRegistry(repo.config.environments || {}, administratorRegistry, repo.root)
    const registry = Object.assign(Object.create(null) as Record<string, EnvironmentSpecInput>, administratorRegistry, repositoryRegistry.registry)
    const approvals = Object.assign(Object.create(null) as Record<string, EnvironmentSpecInput>, administratorRegistry, repositoryRegistry.approvals)
    const globalDefault = administratorRegistry[input.config.defaultEnvironment]
    if (!globalDefault) throw new Error(`environments.defaultEnvironment references missing administrator environment: ${input.config.defaultEnvironment}`)
    let spec: EnvironmentSpecInput = { ...globalDefault, name: input.config.defaultEnvironment }
    source.push(`config:${input.config.defaultEnvironment}`)

    const repositorySelector = repoSelector(repo.config, input.stage)
    const layers = [
      input.profileEnvironment ? selectorSpec(input.profileEnvironment, administratorRegistry, 'profile') : undefined,
      repositorySelector ? repositorySelectorSpec(repositorySelector, registry, approvals, repo.root) : undefined,
      input.roadmapEnvironment ? selectorSpec(input.roadmapEnvironment, registry, 'roadmap') : undefined,
      input.taskEnvironment ? selectorSpec(input.taskEnvironment, registry, 'task') : undefined,
    ]
    for (const resolved of layers) {
      if (resolved) {
        spec = mergeSpecInputs(spec, resolved.spec)
        source.push(resolved.source)
      }
    }

    if (requestedWorkdir && !spec.workdir) spec.workdir = requestedWorkdir
    if (input.requiredTools?.length) spec.tools = uniqueStrings([...(spec.tools || []), ...input.requiredTools])
    const normalized = normalizeEnvironmentSpec(spec, source)
    return { ok: true, spec: normalized, repoConfigPath: repo.path }
  } catch (err: any) {
    return { ok: false, reason: err?.message || String(err), source }
  }
}

export function prepareEnvironment(spec: EnvironmentSpec, options: EnvironmentPrepareOptions = { taskId: 'unknown', stage: 'unknown' }): EnvironmentRunRecord {
  assertEnvironmentNetworkPolicy(spec)
  assertEnvironmentFilesystemPolicy(spec)
  const idempotencyKey = options.idempotencyKey ? normalizeEnvironmentIdempotencyKey(options.idempotencyKey) : undefined
  const now = options.now || new Date()
  const preflight = preflightEnvironment(spec)
  return {
    id: `env_${randomUUID()}`,
    name: spec.name,
    backend: spec.backend,
    status: preflight.ok ? 'prepared' : 'blocked',
    specHash: spec.specHash,
    workdir: spec.workdir,
    runtime: environmentRuntime(spec),
    image: spec.container?.image,
    provider: spec.crabbox?.provider,
    class: spec.crabbox?.class,
    leaseId: spec.backend === 'remote-crabbox' ? `crabbox:${options.taskId}:${options.stage}` : undefined,
    startedAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ttlMs: spec.cleanup.ttlMs,
    cleanup: { retainOnFailure: spec.cleanup.retainOnFailure, retainOnSuccess: spec.cleanup.retainOnSuccess, state: 'pending' },
    resources: spec.resources,
    network: spec.network,
    secrets: { allowedNames: spec.secrets.allow.slice().sort() },
    preflight,
    artifacts: [],
    metadata: {
      ...environmentMetadata(spec),
      dispatchId: options.dispatchId,
      acquisitionKeyHash: idempotencyKey ? environmentIdempotencyKeyHash(idempotencyKey) : undefined,
    },
  }
}


function hydrateSourcePlan(plan: EnvironmentSourcePlan | undefined, workdir: string | undefined): EnvironmentHydrationResult | undefined {
  if (!plan || !plan.required) return undefined
  const patchIds = plan.patches.map(patch => patch.id)
  const changedFiles = uniqueStrings(plan.patches.flatMap(patch => patch.changedFiles)).sort()
  const source = sourceHydrationSummary(plan, 'failed')
  const evidence = [
    `source base ref: ${plan.baseRef}`,
    `dependency tasks: ${plan.dependencyTaskIds.join(',') || 'none'}`,
    `patches: ${patchIds.join(',') || 'none'}`,
    `changed files: ${changedFiles.join(',') || 'none'}`,
  ]
  if (plan.missing.length) {
    const reason = plan.missing.map(item => `${item.taskId}: ${item.reason}`).join('; ')
    return { ok: false, status: 'failed', reason: `Missing dependency patch artifact: ${reason}`, evidence: [...evidence, `missing: ${reason}`], artifacts: [], source: { ...source, missing: plan.missing } }
  }
  const target = workdir || plan.workdir
  if (!target) return { ok: false, status: 'failed', reason: 'Dependency source hydration requires a workdir', evidence, artifacts: [], source }
  for (const patch of plan.patches) {
    const check = gitApply(target, patch.content, ['--check'])
    if (check.ok) {
      const applied = gitApply(target, patch.content, [])
      if (!applied.ok) return { ok: false, status: 'failed', reason: `Patch apply failed for ${patch.id}: ${applied.error}`, evidence: [...evidence, `patch ${patch.id} apply failed: ${applied.error}`], artifacts: patchIds, source }
      continue
    }
    const alreadyApplied = gitApply(target, patch.content, ['--reverse', '--check'])
    if (alreadyApplied.ok) {
      evidence.push(`patch already applied: ${patch.id}`)
      continue
    }
    return { ok: false, status: 'failed', reason: `Patch check failed for ${patch.id}: ${check.error}`, evidence: [...evidence, `patch ${patch.id} check failed: ${check.error}`], artifacts: patchIds, source }
  }
  return { ok: true, status: 'applied', evidence: [...evidence, `dependency source plan applied in ${target}`], artifacts: patchIds, source: { ...source, applyResult: 'applied' } }
}

function sourceHydrationSummary(plan: EnvironmentSourcePlan, applyResult: EnvironmentSourceHydrationSummary['applyResult']): EnvironmentSourceHydrationSummary {
  return {
    baseRef: plan.baseRef,
    dependencyTaskIds: plan.dependencyTaskIds.slice().sort(),
    patchIds: plan.patches.map(patch => patch.id),
    changedFiles: uniqueStrings(plan.patches.flatMap(patch => patch.changedFiles)).sort(),
    applyResult,
    ...(plan.missing.length ? { missing: plan.missing } : {}),
  }
}

function gitApply(workdir: string, patch: string, args: string[]): { ok: boolean; error?: string } {
  const result = spawnSync('git', ['-C', workdir, 'apply', ...args, '-'], { input: patch, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status === 0) return { ok: true }
  return { ok: false, error: shortText([result.stderr, result.stdout].filter(Boolean).join('\n') || `git apply exited ${result.status}`, 500) }
}

function normalizeEnvironmentRegistry(input: Record<string, unknown>): Record<string, EnvironmentSpecInput> {
  const registry = Object.create(null) as Record<string, EnvironmentSpecInput>
  for (const [name, value] of Object.entries(input || {})) {
    const key = normalizeEnvironmentName(name, `environments.${name}`)
    if (typeof value !== 'object' || !value || Array.isArray(value)) throw new Error(`environments.${name} must be an object`)
    registry[key] = { ...sanitizeSpecInput(value as Record<string, unknown>, `environments.${name}`), name: key }
  }
  return registry
}

function resolveEnvironmentRegistry(input: Record<string, unknown>, owner: string): Record<string, EnvironmentSpecInput> {
  const raw = normalizeEnvironmentRegistry(input)
  const resolved = Object.create(null) as Record<string, EnvironmentSpecInput>
  const resolving = new Set<string>()
  const resolveOne = (name: string): EnvironmentSpecInput => {
    if (resolved[name]) return resolved[name]!
    const definition = raw[name]
    if (!definition) throw new Error(`${owner} environment references missing environment: ${name}`)
    if (resolving.has(name)) throw new Error(`${owner} environment inheritance contains a cycle at: ${name}`)
    resolving.add(name)
    const baseName = definition.extends || definition.environment
    const merged = baseName ? mergeSpecInputs(resolveOne(baseName), definition) : { ...definition }
    resolving.delete(name)
    const flattened = flattenEnvironmentInput({ ...merged, name })
    resolved[name] = flattened
    return flattened
  }
  for (const name of Object.keys(raw)) resolveOne(name)
  return resolved
}

interface RepositoryEnvironmentRegistry {
  registry: Record<string, EnvironmentSpecInput>
  approvals: Record<string, EnvironmentSpecInput>
}

function resolveRepositoryEnvironmentRegistry(input: Record<string, EnvironmentSpecInput>, administratorRegistry: Record<string, EnvironmentSpecInput>, repoRoot?: string): RepositoryEnvironmentRegistry {
  const raw = normalizeEnvironmentRegistry(input)
  const registry = Object.create(null) as Record<string, EnvironmentSpecInput>
  const approvals = Object.create(null) as Record<string, EnvironmentSpecInput>
  const resolving = new Set<string>()
  const resolveOne = (name: string): EnvironmentSpecInput => {
    if (registry[name]) return registry[name]!
    const definition = raw[name]
    if (!definition) throw new Error(`repository environment references missing environment: ${name}`)
    if (resolving.has(name)) throw new Error(`repository environment inheritance contains a cycle at: ${name}`)
    resolving.add(name)
    const baseName = definition.extends || definition.environment || (administratorRegistry[name] ? name : undefined)
    if (!baseName) {
      throw new Error(`repository environment ${name} must extend or replace an administrator-approved environment`)
    }
    let base: EnvironmentSpecInput | undefined
    let approval: EnvironmentSpecInput | undefined
    if (administratorRegistry[baseName]) {
      base = administratorRegistry[baseName]
      approval = base
    } else if (raw[baseName]) {
      base = resolveOne(baseName)
      approval = approvals[baseName]
    }
    if (!base || !approval) {
      throw new Error(`repository environment ${name} references environment ${baseName}, which is not anchored to an administrator-approved environment`)
    }
    const secured = secureRepositoryEnvironment(base, definition, approval, repoRoot, name)
    resolving.delete(name)
    registry[name] = flattenEnvironmentInput({ ...secured, name })
    approvals[name] = approval
    return registry[name]!
  }
  for (const name of Object.keys(raw)) resolveOne(name)
  return { registry, approvals }
}

function repositorySelectorSpec(
  selector: EnvironmentSelector,
  registry: Record<string, EnvironmentSpecInput>,
  approvals: Record<string, EnvironmentSpecInput>,
  repoRoot?: string,
): { spec: EnvironmentSpecInput; source: string } {
  if (typeof selector === 'string') {
    const name = normalizeEnvironmentName(selector, 'repo.environment')
    const base = registry[name]
    const approval = approvals[name]
    if (!base || !approval) throw new Error(`repo environment references missing administrator-approved environment: ${name}`)
    return { spec: secureRepositoryEnvironment(base, {}, approval, repoRoot, name), source: `repo:${name}` }
  }
  if (!selector || typeof selector !== 'object' || Array.isArray(selector)) throw new Error('repo environment must be an environment name or object')
  const normalized = sanitizeSpecInput(selector as Record<string, unknown>, 'repo.environment')
  const baseName = normalized.extends || normalized.environment || (normalized.name && registry[normalized.name] ? normalized.name : undefined)
  const base = baseName ? registry[baseName] : undefined
  const approval = baseName ? approvals[baseName] : undefined
  if (!baseName || !base || !approval) throw new Error('inline repo environment must select an administrator-approved environment with extends, environment, or name')
  return {
    spec: secureRepositoryEnvironment(base, normalized, approval, repoRoot, normalized.name || baseName),
    source: `repo:${baseName}`,
  }
}

function secureRepositoryEnvironment(
  base: EnvironmentSpecInput,
  override: EnvironmentSpecInput,
  approval: EnvironmentSpecInput,
  repoRoot: string | undefined,
  name: string,
): EnvironmentSpecInput {
  const approvedBackend = normalizeBackend(approval.backend || 'local-process')
  const merged = mergeSpecInputs(base, override)
  const requestedBackend = normalizeBackend(merged.backend || 'local-process')
  if (requestedBackend !== approvedBackend) {
    throw new Error(`repository environment ${name} may not change administrator-approved backend ${approvedBackend} to ${requestedBackend}`)
  }
  if (Object.hasOwn(override, 'custom')) {
    throw new Error(`repository environment ${name} may not override administrator-owned custom adapter configuration`)
  }
  if (approvedBackend !== 'local-container' && Object.hasOwn(override, 'container')) {
    throw new Error(`repository environment ${name} may not add local-container adapter configuration to backend ${approvedBackend}`)
  }
  if (approvedBackend !== 'remote-crabbox' && Object.hasOwn(override, 'crabbox')) {
    throw new Error(`repository environment ${name} may not add remote-crabbox adapter configuration to backend ${approvedBackend}`)
  }
  assertRepositoryEnvironmentMonotonic(base, override, merged, repoRoot, name)
  merged.backend = approvedBackend
  if (approvedBackend === 'local-container' || approvedBackend === 'remote-crabbox') {
    const approvedExecutable = environmentRuntimeExecutable(approval, approvedBackend)
    const requestedExecutable = environmentRuntimeExecutable(merged, approvedBackend)
    const approvedCanonical = canonicalRuntimeExecutable(approvedExecutable, `administrator environment ${approval.name || name}`)
    const requestedCanonical = canonicalRuntimeExecutable(requestedExecutable, `repository environment ${name}`)
    if (approvedCanonical !== requestedCanonical) {
      throw new Error(`repository environment ${name} runtime executable is not administrator-approved`)
    }
    if (repoRoot && isPathWithinRoot(approvedCanonical, canonicalPath(repoRoot))) {
      throw new Error(`repository environment ${name} runtime executable must be outside the repository config root`)
    }
    if (approvedBackend === 'local-container') {
      merged.container = { ...(merged.container || {}), runtime: approvedCanonical }
    } else {
      merged.crabbox = { ...(merged.crabbox || {}), cli: approvedCanonical }
    }
  }
  return merged
}

function assertRepositoryEnvironmentMonotonic(
  base: EnvironmentSpecInput,
  override: EnvironmentSpecInput,
  merged: EnvironmentSpecInput,
  repoRoot: string | undefined,
  name: string,
): void {
  const prefix = `repository environment ${name}`
  const knownTopLevel = new Set(['name', 'extends', 'environment', 'backend', 'workdir', 'tools', 'setup', 'validation', 'env', 'resources', 'network', 'secrets', 'cache', 'cleanup', 'container', 'crabbox', 'custom'])
  const unknownTopLevel = Object.keys(override).filter(field => !knownTopLevel.has(field))
  if (unknownTopLevel.length) throw new Error(`${prefix} contains unsupported capability fields: ${unknownTopLevel.join(', ')}`)
  const baseSetup = new Set(base.setup || [])
  const addedSetup = (override.setup || []).filter(command => !baseSetup.has(command))
  if (addedSetup.length) throw new Error(`${prefix} may not add administrator-unapproved setup commands`)

  const baseSecrets = new Set(base.secrets?.allow || [])
  const addedSecrets = (override.secrets?.allow || []).filter(secret => !baseSecrets.has(secret))
  if (addedSecrets.length) throw new Error(`${prefix} may not expand administrator-approved secret forwarding: ${addedSecrets.join(', ')}`)

  if (base.backend === 'remote-crabbox') {
    const hostControlEnv = Object.keys(override.env || {}).filter(name => REMOTE_HOST_PROCESS_CONTROL_ENV_PATTERN.test(name))
    if (hostControlEnv.length) {
      throw new Error(`${prefix} may not set host process control variables for remote-crabbox: ${hostControlEnv.join(', ')}`)
    }
  }

  assertRepositoryNetworkMonotonic(base.network, merged.network, prefix)
  assertRepositoryResourcesMonotonic(base.resources, merged.resources, prefix)
  assertRepositoryCleanupMonotonic(base.cleanup, merged.cleanup, prefix)
  assertRepositoryCacheMonotonic(base.cache, override.cache, prefix)
  assertRepositoryContainerMonotonic(base.container, override.container, merged.container, prefix)
  assertRepositoryCrabboxMonotonic(base.crabbox, override.crabbox, prefix)

  if (Object.hasOwn(override, 'workdir')) {
    if (!repoRoot) throw new Error(`${prefix} may not set workdir without a canonical repository checkout root`)
    const workdir = canonicalEnvironmentPath(normalizeRequiredPath(override.workdir, `${prefix}.workdir`), repoRoot)
    const checkout = canonicalEnvironmentPath(repoRoot)
    assertSafeEnvironmentWorkdir(checkout, 'repository checkout')
    assertSafeEnvironmentWorkdir(workdir, `${prefix} workdir`)
    if (!isPathWithinRoot(workdir, checkout)) throw new Error(`${prefix} workdir must remain inside the canonical repository checkout`)
    if (base.workdir) {
      const approvedWorkdir = canonicalEnvironmentPath(base.workdir)
      if (!isPathWithinRoot(workdir, approvedWorkdir)) throw new Error(`${prefix} workdir may not broaden the administrator-approved workdir`)
    }
    merged.workdir = workdir
  }
}

function assertRepositoryResourcesMonotonic(baseInput: EnvironmentResources | undefined, mergedInput: EnvironmentResources | undefined, prefix: string): void {
  const base = normalizeResources(baseInput || {})
  const requested = normalizeResources(mergedInput || {})
  for (const field of ['cpu', 'memoryGb', 'diskGb', 'maxConcurrent'] as const) {
    const approved = base[field]
    const value = requested[field]
    if (approved !== undefined && value !== undefined && value > approved) {
      throw new Error(`${prefix} may not expand environment.resources.${field} above the administrator-approved limit`)
    }
  }
  for (const field of ['memory', 'disk'] as const) {
    const approved = base[field]
    const value = requested[field]
    if (approved !== undefined && value !== undefined && value !== approved && resourceQuantity(value) > resourceQuantity(approved)) {
      throw new Error(`${prefix} may not expand environment.resources.${field} above the administrator-approved limit`)
    }
  }
  if (requested.timeoutMs > base.timeoutMs) {
    throw new Error(`${prefix} may not expand environment.resources timeout above the administrator-approved limit`)
  }
}

function assertRepositoryCleanupMonotonic(baseInput: EnvironmentCleanupPolicy | undefined, mergedInput: EnvironmentCleanupPolicy | undefined, prefix: string): void {
  const base = normalizeCleanup(baseInput || {})
  const requested = normalizeCleanup(mergedInput || {})
  if (requested.ttlMs > base.ttlMs) throw new Error(`${prefix} may not expand environment cleanup TTL`)
  if (requested.retainOnFailure && !base.retainOnFailure) throw new Error(`${prefix} may not enable cleanup.retainOnFailure`)
  if (requested.retainOnSuccess && !base.retainOnSuccess) throw new Error(`${prefix} may not enable cleanup.retainOnSuccess`)
}

function assertRepositoryCacheMonotonic(base: EnvironmentCachePolicy | undefined, override: EnvironmentCachePolicy | undefined, prefix: string): void {
  if (!override?.volumes?.length) return
  const approved = normalizeCache(base || {}).volumes
  const requested = normalizeCache(override).volumes
  for (const volume of requested) {
    const match = approved.find(candidate => candidate.name === volume.name && candidate.path === volume.path)
    if (!match || (match.mode === 'readonly' && volume.mode !== 'readonly')) {
      throw new Error(`${prefix} may not add or widen administrator-approved cache volumes`)
    }
  }
}

function resourceQuantity(value: string): number {
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*([kmgtpe]?i?b?)?$/i)
  if (!match) throw new Error(`environment resource quantity is not comparable: ${value}`)
  const unit = String(match[2] || '').toLowerCase()
  const powers: Record<string, number> = { '': 0, b: 0, k: 1, kb: 1, ki: 1, kib: 1, m: 2, mb: 2, mi: 2, mib: 2, g: 3, gb: 3, gi: 3, gib: 3, t: 4, tb: 4, ti: 4, tib: 4, p: 5, pb: 5, pi: 5, pib: 5, e: 6, eb: 6, ei: 6, eib: 6 }
  const power = powers[unit]
  if (power === undefined) throw new Error(`environment resource quantity is not comparable: ${value}`)
  return Number(match[1]) * 1024 ** power
}

function assertRepositoryNetworkMonotonic(baseInput: EnvironmentNetwork | undefined, mergedInput: EnvironmentNetwork | undefined, prefix: string): void {
  const base = normalizeNetwork(baseInput || {})
  const requested = normalizeNetwork(mergedInput || {})
  const rank: Record<EnvironmentSpec['network']['mode'], number> = { disabled: 0, restricted: 1, unrestricted: 2 }
  if (rank[requested.mode] > rank[base.mode]) {
    throw new Error(`${prefix} may not expand network mode from ${base.mode} to ${requested.mode}`)
  }
  const approvedAllow = new Set(base.allow || [])
  const added = (requested.allow || []).filter(target => !approvedAllow.has(target))
  if (added.length) throw new Error(`${prefix} may not expand administrator-approved network destinations: ${added.join(', ')}`)
}

function assertRepositoryContainerMonotonic(
  base: LocalContainerSpec | undefined,
  override: LocalContainerSpec | undefined,
  merged: LocalContainerSpec | undefined,
  prefix: string,
): void {
  if (!override) return
  const knownFields = new Set(['runtime', 'image', 'entrypoint', 'workdir', 'user', 'network', 'privileged', 'mounts', 'pull', 'warm'])
  const unknownFields = Object.keys(override).filter(field => !knownFields.has(field))
  if (unknownFields.length) throw new Error(`${prefix} contains unsupported container capability fields: ${unknownFields.join(', ')}`)
  for (const field of ['image', 'entrypoint', 'user', 'workdir', 'pull'] as const) {
    if (Object.hasOwn(override, field) && !sameEnvironmentValue(override[field], base?.[field])) {
      throw new Error(`${prefix} may not override administrator-owned container.${field}`)
    }
  }
  if (override.privileged === true && base?.privileged !== true) {
    throw new Error(`${prefix} may not enable privileged container execution`)
  }
  if (Object.hasOwn(override, 'network')) {
    const requested = override.network
    const approved = base?.network
    if (requested !== approved && requested !== 'none') {
      throw new Error(`${prefix} may not expand administrator-owned container.network`)
    }
  }
  if (Object.hasOwn(override, 'mounts')) {
    const approvedMounts = normalizeContainerMounts(base?.mounts) || []
    const requestedMounts = normalizeContainerMounts(merged?.mounts) || []
    for (const mount of requestedMounts) {
      const source = canonicalEnvironmentPath(mount.source)
      const approved = approvedMounts.find(candidate => canonicalEnvironmentPath(candidate.source) === source && candidate.target === mount.target)
      if (!approved || (approved.readonly === true && mount.readonly !== true)) {
        throw new Error(`${prefix} may not add or widen administrator-approved container mounts`)
      }
    }
  }
}

function assertRepositoryCrabboxMonotonic(
  base: CrabboxSpec | undefined,
  override: CrabboxSpec | undefined,
  prefix: string,
): void {
  if (!override) return
  const knownFields = new Set(['cli', 'brokerUrl', 'profile', 'provider', 'class', 'ttl', 'warm', 'keepOnFailure', 'actionsHydration'])
  const unknownFields = Object.keys(override).filter(field => !knownFields.has(field))
  if (unknownFields.length) throw new Error(`${prefix} contains unsupported Crabbox capability fields: ${unknownFields.join(', ')}`)
  for (const field of ['brokerUrl', 'profile', 'provider', 'class'] as const) {
    if (Object.hasOwn(override, field) && !sameEnvironmentValue(override[field], base?.[field])) {
      throw new Error(`${prefix} may not override administrator-owned crabbox.${field}`)
    }
  }
  if (override.keepOnFailure === true && base?.keepOnFailure !== true) {
    throw new Error(`${prefix} may not enable crabbox.keepOnFailure`)
  }
  if (override.actionsHydration === true && base?.actionsHydration !== true) {
    throw new Error(`${prefix} may not enable crabbox.actionsHydration`)
  }
  if (Object.hasOwn(override, 'ttl')) {
    const approvedTtl = base?.ttl ? durationMs(base.ttl, DEFAULT_TTL_MS) : DEFAULT_TTL_MS
    const requestedTtl = override.ttl ? durationMs(override.ttl, DEFAULT_TTL_MS) : approvedTtl
    if (requestedTtl > approvedTtl) throw new Error(`${prefix} may not expand crabbox.ttl`)
  }
}

function sameEnvironmentValue(left: unknown, right: unknown): boolean {
  return stableStringifyDefined(left) === stableStringifyDefined(right)
}

function environmentRuntimeExecutable(spec: EnvironmentSpecInput, backend: 'local-container' | 'remote-crabbox'): string {
  const value = backend === 'local-container' ? spec.container?.runtime : spec.crabbox?.cli
  const fallback = backend === 'local-container' ? 'docker' : 'crabbox'
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'string' || value.includes('\0') || /[\r\n]/.test(value) || !value.trim()) {
    throw new Error(`environment ${backend === 'local-container' ? 'container.runtime' : 'crabbox.cli'} must be one executable path or command name`)
  }
  return value.trim()
}

function canonicalRuntimeExecutable(executable: string, label: string): string {
  const hasPathSeparator = executable.includes('/') || executable.includes('\\')
  const extensions = process.platform === 'win32'
    ? uniqueStrings(['', ...String(process.env['PATHEXT'] || '.EXE;.CMD;.BAT;.COM').split(';').map(value => value.toLowerCase())])
    : ['']
  const candidates = hasPathSeparator || path.isAbsolute(executable)
    ? [path.resolve(executable)]
    : (process.env['PATH'] || '').split(path.delimiter).filter(Boolean).flatMap(dir => extensions.map(ext => path.resolve(dir, executable.toLowerCase().endsWith(ext) ? executable : executable + ext)))
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      const canonical = fs.realpathSync(candidate)
      if (fs.statSync(canonical).isFile()) return canonical
    } catch {}
  }
  throw new Error(`${label} runtime executable cannot be canonically resolved; repository runtime approval fails closed`)
}

function canonicalPath(value: string): string {
  return canonicalEnvironmentPath(value)
}

function canonicalEnvironmentPath(value: string, base = process.cwd()): string {
  const resolved = path.resolve(base, value)
  let existing = resolved
  const suffix: string[] = []
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing)
    if (parent === existing) break
    suffix.unshift(path.basename(existing))
    existing = parent
  }
  try {
    return path.resolve(fs.realpathSync(existing), ...suffix)
  } catch {
    return resolved
  }
}

function assertSafeEnvironmentWorkdir(workdir: string, label: string): void {
  const canonical = canonicalEnvironmentPath(workdir)
  const reason = sensitiveEnvironmentPathReason(canonical)
  if (reason) throw new Error(`${label} may not use ${reason}: ${canonical}`)
  try {
    if (fs.existsSync(canonical) && !fs.statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory: ${canonical}`)
  } catch (err: any) {
    if (String(err?.message || err).includes('must be a directory')) throw err
    throw new Error(`${label} could not be inspected safely: ${canonical}`)
  }
}

function sensitiveEnvironmentPathReason(candidate: string): string | undefined {
  const canonical = canonicalEnvironmentPath(candidate)
  if (canonical === path.parse(canonical).root) return 'a filesystem root as workdir'
  const home = canonicalEnvironmentPath(os.homedir())
  if (canonical === home) return 'the user home root as workdir'
  const sensitiveTrees = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.kube'),
    path.join(home, '.config'),
    ...(process.platform === 'win32' ? [] : ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run']),
  ].map(value => canonicalEnvironmentPath(value))
  if (sensitiveTrees.some(root => isPathWithinRoot(canonical, root))) return 'a sensitive host path as workdir'
  return undefined
}

function isPathWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

function flattenEnvironmentInput(input: EnvironmentSpecInput): EnvironmentSpecInput {
  const flattened = { ...input }
  delete flattened.extends
  delete flattened.environment
  return flattened
}

function selectorSpec(selector: EnvironmentSelector, registry: Record<string, EnvironmentSpecInput>, label: string): { spec: EnvironmentSpecInput; source: string } {
  if (typeof selector === 'string') {
    const named = registry[selector]
    if (!named) throw new Error(`${label} environment references missing environment: ${selector}`)
    return { spec: { ...named, name: selector }, source: `${label}:${selector}` }
  }
  const baseName = selector.extends || selector.environment || (selector.name && registry[selector.name] ? selector.name : undefined)
  const base = baseName ? registry[baseName] : undefined
  if (baseName && !base) throw new Error(`${label} environment extends missing environment: ${baseName}`)
  return { spec: base ? mergeSpecInputs({ ...base, name: baseName }, selector) : selector, source: `${label}:${baseName || selector.name || 'inline'}` }
}

function repoSelector(config: RepoEnvironmentConfig, stage: string): EnvironmentSelector | undefined {
  return config.stages?.[stage] || config.defaultEnvironment || config.default
}

interface RepoEnvironmentConfig {
  default?: EnvironmentSelector
  defaultEnvironment?: EnvironmentSelector
  stages?: Record<string, EnvironmentSelector>
  environments?: Record<string, EnvironmentSpecInput>
}

function loadRepoEnvironmentConfig(workdir?: string): { path?: string; root?: string; config: RepoEnvironmentConfig } {
  if (!workdir) return { config: {} }
  const dir = findRepoConfigDir(workdir)
  if (!dir) return { config: {} }
  for (const name of ['env.json', 'env.yaml', 'env.yml']) {
    const file = path.join(dir, '.gateway', name)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf-8')
    const parsed = name.endsWith('.json') ? JSON.parse(text) : parseSimpleYaml(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${file} must contain an object`)
    return { path: file, root: canonicalEnvironmentPath(dir), config: parsed as RepoEnvironmentConfig }
  }
  return { config: {} }
}

function findRepoConfigDir(start: string): string | undefined {
  let current = canonicalEnvironmentPath(start)
  try {
    const stat = fs.existsSync(current) ? fs.statSync(current) : undefined
    if (stat?.isFile()) current = path.dirname(current)
  } catch {}
  for (;;) {
    if (fs.existsSync(path.join(current, '.gateway'))) return current
    const parent = path.dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

function normalizeEnvironmentSpec(input: EnvironmentSpecInput, source: string[]): EnvironmentSpec {
  const name = normalizeEnvironmentName(input.name || input.environment || DEFAULT_ENVIRONMENT_NAME, 'environment.name')
  const backend = normalizeBackend(input.backend || 'local-process')
  const resources = normalizeResources(input.resources || {})
  const network = normalizeNetwork(input.network || {})
  const secrets = normalizeSecrets(input.secrets || {})
  const cleanup = normalizeCleanup(input.cleanup || {})
  const spec: Omit<EnvironmentSpec, 'specHash'> = {
    name,
    backend,
    workdir: normalizeOptionalEnvironmentWorkdir(input.workdir, 'environment.workdir'),
    tools: uniqueStrings(input.tools || []),
    setup: uniqueStrings(input.setup || []),
    validation: uniqueStrings(input.validation || []),
    env: normalizeEnv(input.env || {}),
    resources,
    network,
    secrets,
    cache: normalizeCache(input.cache || {}),
    cleanup,
    container: normalizeContainer(input.container || {}, backend),
    crabbox: normalizeCrabbox(input.crabbox || {}, backend),
    custom: input.custom && typeof input.custom === 'object' && !Array.isArray(input.custom) ? input.custom as Record<string, unknown> : undefined,
    source,
  }
  assertBackendSpec(spec)
  const hashInput = stableStringifyDefined({ ...spec, source: undefined })
  return { ...spec, specHash: createHash('sha256').update(hashInput).digest('hex').slice(0, 16) }
}

function mergeSpecInputs(base: EnvironmentSpecInput, override: EnvironmentSpecInput): EnvironmentSpecInput {
  const merged: EnvironmentSpecInput = { ...base, ...override }
  merged.tools = uniqueStrings([...(base.tools || []), ...(override.tools || [])])
  merged.setup = uniqueStrings([...(base.setup || []), ...(override.setup || [])])
  merged.validation = uniqueStrings([...(base.validation || []), ...(override.validation || [])])
  merged.env = { ...(base.env || {}), ...(override.env || {}) }
  merged.resources = { ...(base.resources || {}), ...(override.resources || {}) }
  merged.network = { ...(base.network || {}), ...(override.network || {}) }
  merged.secrets = { allow: uniqueStrings([...(base.secrets?.allow || []), ...(override.secrets?.allow || [])]) }
  merged.cache = { volumes: [...(base.cache?.volumes || []), ...(override.cache?.volumes || [])] }
  merged.cleanup = { ...(base.cleanup || {}), ...(override.cleanup || {}) }
  merged.container = { ...(base.container || {}), ...(override.container || {}) }
  merged.crabbox = { ...(base.crabbox || {}), ...(override.crabbox || {}) }
  return merged
}

function preflightEnvironment(spec: EnvironmentSpec): EnvironmentPreflightResult {
  const checked: string[] = []
  const missing: string[] = []
  const warnings: string[] = []
  const commandRefs: string[] = []
  let localContainerRuntimeOk = true
  let localContainerImageOk = true
  if (spec.backend === 'local-container') {
    const runtime = spec.container?.runtime || 'docker'
    checked.push(runtime)
    commandRefs.push(`${runtime} --version`)
    const runtimeOk = binaryAvailable(runtime)
    localContainerRuntimeOk = runtimeOk
    if (!runtimeOk) missing.push(runtime)
    localContainerImageOk = Boolean(spec.container?.image)
    if (spec.container?.image) {
      checked.push(`image:${spec.container.image}`)
      commandRefs.push(`${runtime} image inspect ${spec.container.image}`)
      if (runtimeOk) {
        const image = inspectLocalContainerImage(spec)
        localContainerImageOk = image.status === 'ok'
        if (!localContainerImageOk) missing.push(`image:${spec.container.image}`)
        if (image.error) warnings.push(`local-container image inspect failed: ${image.error}`)
      }
    }
    if (!spec.container?.image) warnings.push('local-container image is not configured')
  }
  if (spec.backend === 'remote-crabbox') {
    const cli = spec.crabbox?.cli || 'crabbox'
    checked.push(cli)
    commandRefs.push(`${cli} --version`)
    if (!binaryAvailable(cli)) missing.push(cli)
  }
  for (const tool of spec.tools) {
    checked.push(tool)
    commandRefs.push(commandRefForTool(spec, tool))
    if (spec.backend === 'local-process' && !toolAvailable(tool, spec.workdir)) missing.push(tool)
    if (spec.backend === 'local-container' && localContainerRuntimeOk && localContainerImageOk) {
      const result = runLocalContainerCommand(spec, ['command', '-v', tool], spec.workdir, `tool:${tool}`)
      if (!result.ok) missing.push(tool)
      if (!result.ok && result.output) warnings.push(`local-container tool check failed for ${tool}: ${result.output}`)
    }
  }
  return { ok: missing.length === 0, checked: uniqueStrings(checked), missing: uniqueStrings(missing), warnings, commandRefs }
}

function commandRefForTool(spec: EnvironmentSpec, tool: string): string {
  if (spec.backend === 'local-container') return [...localContainerCommandPrefix(spec, spec.workdir), 'command', '-v', tool].join(' ')
  if (spec.backend === 'remote-crabbox') return `${spec.crabbox?.cli || 'crabbox'} run --id <lease-id> -- command -v ${tool}`
  return `command -v ${tool}`
}

function toolAvailable(tool: string, directory: string | undefined): boolean {
  if (tool === 'rust') return binaryAvailable('cargo') && binaryAvailable('rustc')
  if (tool === 'python') return binaryAvailable('python3') || binaryAvailable('python')
  if (tool === 'mkdocs') return binaryAvailable('mkdocs') || (binaryAvailable('uv') && fs.existsSync(path.join(directory || process.cwd(), 'docs', 'requirements.txt')))
  return binaryAvailable(tool)
}

function assertBackendSpec(spec: Omit<EnvironmentSpec, 'specHash'>): void {
  if (spec.backend === 'local-container' && !spec.container?.image) throw new Error(`environment ${spec.name} local-container requires container.image`)
  if (spec.backend === 'remote-crabbox' && !spec.crabbox?.profile && !spec.crabbox?.brokerUrl) throw new Error(`environment ${spec.name} remote-crabbox requires crabbox.profile or crabbox.brokerUrl`)
  assertEnvironmentNetworkPolicy(spec)
  assertEnvironmentFilesystemPolicy(spec)
  const disallowedSecrets = Object.keys(spec.env).filter(key => SECRET_NAME_PATTERN.test(key) && !spec.secrets.allow.includes(key))
  if (disallowedSecrets.length) throw new Error(`environment ${spec.name} may not forward secret-like env keys without secrets.allow entries: ${disallowedSecrets.join(', ')}`)
}

function assertEnvironmentNetworkPolicy(spec: Pick<EnvironmentSpec, 'name' | 'backend' | 'network' | 'container'>): void {
  if (spec.network.mode !== 'restricted' && spec.network.allow?.length) {
    throw new Error(`environment ${spec.name} network.allow is only valid with network.mode=restricted`)
  }
  if (spec.backend === 'local-container') assertContainerNetworkPolicy(spec)
}

function assertEnvironmentFilesystemPolicy(spec: Pick<EnvironmentSpec, 'name' | 'backend' | 'workdir' | 'container'>): void {
  if (spec.workdir) assertSafeEnvironmentWorkdir(spec.workdir, `environment ${spec.name} workdir`)
  if (spec.backend !== 'local-container') return
  const allowedRoots = [spec.workdir, process.cwd(), os.tmpdir()]
    .filter((value): value is string => Boolean(value))
    .map(value => canonicalEnvironmentPath(value))
  for (const mount of spec.container?.mounts || []) {
    const source = canonicalEnvironmentPath(mount.source)
    const sensitive = sensitiveEnvironmentPathReason(source)
    if (sensitive) throw new Error(`environment ${spec.name} container mount source may not use ${sensitive}: ${source}`)
    if (!allowedRoots.some(root => isPathWithinRoot(source, root))) {
      throw new Error(`environment ${spec.name} container mount source must remain under an approved workdir, daemon checkout, or temporary directory`)
    }
  }
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

function environmentRuntime(spec: EnvironmentSpec): string | undefined {
  if (spec.backend === 'local-container') return spec.container?.runtime || 'docker'
  if (spec.backend === 'remote-crabbox') return spec.crabbox?.cli || 'crabbox'
  return process.execPath
}

function environmentMetadata(spec: EnvironmentSpec): Record<string, unknown> {
  const crabbox = spec.crabbox ? { ...spec.crabbox, brokerUrl: spec.crabbox.brokerUrl ? '<configured>' : undefined } : undefined
  return redactEnvironmentRecord({ source: spec.source, setup: spec.setup, validation: spec.validation, cacheVolumes: spec.cache.volumes, container: spec.container, crabbox })
}

function normalizeBackend(value: unknown): EnvironmentBackend {
  if (value === 'local-process' || value === 'local-container' || value === 'remote-crabbox' || value === 'custom') return value
  throw new Error(`environment.backend must be local-process, local-container, remote-crabbox, or custom: ${String(value)}`)
}

function normalizeBackendMaxConcurrent(input: unknown): Partial<Record<EnvironmentBackend, number>> {
  if (!input) return {}
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('environments.backendMaxConcurrent must be an object')
  const out: Partial<Record<EnvironmentBackend, number>> = {}
  for (const [backend, value] of Object.entries(input as Record<string, unknown>)) {
    out[normalizeBackend(backend)] = boundedInteger(value, 1, 500, `environments.backendMaxConcurrent.${backend}`)
  }
  return out
}

function normalizeEnvironmentName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = value.trim()
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(text)) throw new Error(`${label} must be 1-128 letters, numbers, dots, colons, underscores, or dashes`)
  return text
}

function normalizeResources(input: EnvironmentResources): EnvironmentSpec['resources'] {
  return {
    cpu: input.cpu === undefined ? undefined : boundedNumber(input.cpu, 0.1, 1024, 'environment.resources.cpu'),
    memory: optionalText(input.memory, 64),
    memoryGb: input.memoryGb === undefined ? undefined : boundedNumber(input.memoryGb, 0.1, 65536, 'environment.resources.memoryGb'),
    disk: optionalText(input.disk, 64),
    diskGb: input.diskGb === undefined ? undefined : boundedNumber(input.diskGb, 0.1, 1_000_000, 'environment.resources.diskGb'),
    timeout: optionalText(input.timeout, 64),
    timeoutMs: input.timeoutMs === undefined ? durationMs(input.timeout, DEFAULT_TIMEOUT_MS) : boundedInteger(input.timeoutMs, 1000, 30 * 24 * 60 * 60 * 1000, 'environment.resources.timeoutMs'),
    maxConcurrent: input.maxConcurrent === undefined ? undefined : boundedInteger(input.maxConcurrent, 1, 500, 'environment.resources.maxConcurrent'),
  }
}

function normalizeNetwork(input: EnvironmentNetwork): EnvironmentSpec['network'] {
  const mode = input.mode || 'restricted'
  if (mode !== 'unrestricted' && mode !== 'restricted' && mode !== 'disabled') throw new Error(`environment.network.mode must be unrestricted, restricted, or disabled`)
  return { mode, allow: uniqueStrings(input.allow || []) }
}

function normalizeSecrets(input: EnvironmentSecretPolicy): EnvironmentSpec['secrets'] {
  return { allow: uniqueStrings(input.allow || []).map(name => {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(name)) throw new Error(`environment.secrets.allow contains invalid environment variable name: ${name}`)
    return name
  }) }
}

function normalizeCache(input: EnvironmentCachePolicy): EnvironmentSpec['cache'] {
  const volumes = (input.volumes || []).map((volume, index) => {
    const name = normalizeEnvironmentName(volume.name, `environment.cache.volumes[${index}].name`)
    const volumePath = normalizeRequiredPath(volume.path, `environment.cache.volumes[${index}].path`)
    const mode: 'readwrite' | 'readonly' = volume.mode === 'readonly' ? 'readonly' : 'readwrite'
    return { name, path: volumePath, mode }
  })
  return { volumes }
}

function normalizeCleanup(input: EnvironmentCleanupPolicy): EnvironmentSpec['cleanup'] {
  return {
    ttlMs: input.ttlMs === undefined ? durationMs(input.ttl, DEFAULT_TTL_MS) : boundedInteger(input.ttlMs, 1000, 30 * 24 * 60 * 60 * 1000, 'environment.cleanup.ttlMs'),
    retainOnFailure: input.retainOnFailure === true,
    retainOnSuccess: input.retainOnSuccess === true,
  }
}

function normalizeContainer(input: LocalContainerSpec, backend: EnvironmentBackend): LocalContainerSpec | undefined {
  if (backend !== 'local-container' && Object.keys(input || {}).length === 0) return undefined
  return {
    ...input,
    runtime: normalizeRuntimeExecutable(input.runtime, 'environment.container.runtime') || 'docker',
    image: optionalText(input.image, 300),
    entrypoint: Array.isArray(input.entrypoint) ? input.entrypoint.map(String) : undefined,
    workdir: optionalText(input.workdir, 300),
    user: optionalText(input.user, 120),
    network: optionalText(input.network, 120),
    privileged: input.privileged === true,
    mounts: normalizeContainerMounts(input.mounts),
    pull: input.pull === 'never' || input.pull === 'always' ? input.pull : 'missing',
    warm: input.warm === true,
  }
}

function normalizeContainerMounts(input: unknown): LocalContainerSpec['mounts'] {
  if (input === undefined || input === null) return undefined
  if (!Array.isArray(input)) throw new Error('environment.container.mounts must be an array')
  return input.map((mount, index) => {
    if (!mount || typeof mount !== 'object' || Array.isArray(mount)) throw new Error(`environment.container.mounts[${index}] must be an object`)
    const record = mount as Record<string, unknown>
    return {
      source: canonicalEnvironmentPath(normalizeRequiredPath(record['source'], `environment.container.mounts[${index}].source`)),
      target: normalizeRequiredPath(record['target'], `environment.container.mounts[${index}].target`),
      readonly: record['readonly'] === true,
    }
  })
}

function normalizeCrabbox(input: CrabboxSpec, backend: EnvironmentBackend): CrabboxSpec | undefined {
  if (backend !== 'remote-crabbox' && Object.keys(input || {}).length === 0) return undefined
  return {
    ...input,
    cli: normalizeRuntimeExecutable(input.cli, 'environment.crabbox.cli') || 'crabbox',
    brokerUrl: optionalText(input.brokerUrl, 500),
    profile: optionalText(input.profile, 120),
    provider: optionalText(input.provider, 120),
    class: optionalText(input.class, 120),
    ttl: optionalText(input.ttl, 64),
    warm: input.warm === true,
    keepOnFailure: input.keepOnFailure === true,
    actionsHydration: input.actionsHydration === true,
  }
}

function normalizeEnv(input: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (!/^[A-Z_][A-Z0-9_]{0,127}$/.test(key)) throw new Error(`environment.env contains invalid variable name: ${key}`)
    env[key] = SECRET_NAME_PATTERN.test(key) ? SECRET_VALUE_PLACEHOLDER : String(value)
  }
  return env
}

function sanitizeSpecInput(input: Record<string, unknown>, label: string): EnvironmentSpecInput {
  const copy = { ...input } as EnvironmentSpecInput
  if (copy.backend !== undefined) copy.backend = normalizeBackend(copy.backend)
  if (copy.name !== undefined) copy.name = normalizeEnvironmentName(copy.name, `${label}.name`)
  if (copy.extends !== undefined) copy.extends = normalizeEnvironmentName(copy.extends, `${label}.extends`)
  if (copy.environment !== undefined) copy.environment = normalizeEnvironmentName(copy.environment, `${label}.environment`)
  if (copy.env !== undefined) {
    if (typeof copy.env !== 'object' || !copy.env || Array.isArray(copy.env)) throw new Error(`${label}.env must be an object`)
    copy.env = normalizeEnv(copy.env as Record<string, string>)
  }
  return copy
}

function normalizeOptionalPath(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return normalizeRequiredPath(value, label)
}

function normalizeOptionalEnvironmentWorkdir(value: unknown, label: string): string | undefined {
  const raw = normalizeOptionalPath(value, label)
  if (!raw) return undefined
  const canonical = canonicalEnvironmentPath(raw)
  assertSafeEnvironmentWorkdir(canonical, label)
  return canonical
}

function normalizeRequiredPath(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a path string`)
  const text = value.trim()
  if (!text || text.includes('\0')) throw new Error(`${label} must be a non-empty path`)
  return text
}

function parseSimpleYaml(text: string): unknown {
  const lines = text.split(/\r?\n/).map(raw => ({ raw, text: raw.replace(/\s+#.*$/, '') })).filter(line => line.text.trim() && !line.text.trim().startsWith('#'))
  const parseBlock = (index: number, indent: number): [unknown, number] => {
    const isArray = lines[index]?.text.match(/^\s*-/)
    if (isArray) {
      const items: unknown[] = []
      while (index < lines.length) {
        const line = lines[index]!.text
        const currentIndent = leadingSpaces(line)
        if (currentIndent < indent || !line.slice(currentIndent).startsWith('-')) break
        const rest = line.slice(currentIndent + 1).trim()
        if (!rest) {
          const [child, next] = parseBlock(index + 1, currentIndent + 2)
          items.push(child)
          index = next
        } else if (/^[^:]+:\s*/.test(rest)) {
          const [key, value] = splitYamlPair(rest)
          const item: Record<string, unknown> = { [key]: value === '' ? {} : yamlScalar(value) }
          index++
          while (index < lines.length && leadingSpaces(lines[index]!.text) > currentIndent) {
            const nested = lines[index]!.text.slice(currentIndent + 2)
            const [nestedKey, nestedValue] = splitYamlPair(nested.trim())
            item[nestedKey] = nestedValue === '' ? parseBlock(index + 1, currentIndent + 4)[0] : yamlScalar(nestedValue)
            index += nestedValue === '' ? 2 : 1
          }
          items.push(item)
        } else {
          items.push(yamlScalar(rest))
          index++
        }
      }
      return [items, index]
    }
    const object: Record<string, unknown> = {}
    while (index < lines.length) {
      const line = lines[index]!.text
      const currentIndent = leadingSpaces(line)
      if (currentIndent < indent || line.slice(currentIndent).startsWith('-')) break
      const [key, value] = splitYamlPair(line.trim())
      if (value === '') {
        const [child, next] = parseBlock(index + 1, currentIndent + 2)
        object[key] = child
        index = next
      } else {
        object[key] = yamlScalar(value)
        index++
      }
    }
    return [object, index]
  }
  return lines.length ? parseBlock(0, leadingSpaces(lines[0]!.text))[0] : {}
}

function splitYamlPair(text: string): [string, string] {
  const idx = text.indexOf(':')
  if (idx < 0) throw new Error(`invalid YAML line: ${text}`)
  return [text.slice(0, idx).trim(), text.slice(idx + 1).trim()]
}

function yamlScalar(value: string): unknown {
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value)
  return value.replace(/^['"]|['"]$/g, '')
}

function leadingSpaces(value: string): number {
  return value.match(/^\s*/)?.[0].length || 0
}
