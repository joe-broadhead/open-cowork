import * as fs from 'node:fs'
import { stableStringifyDefined } from './stable-stringify.js'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'

export * from './environments/types.js'
import type {
  CrabboxSpec,
  EnvironmentAcquisitionLookupResult,
  EnvironmentAcquisitionReleaseResult,
  EnvironmentArtifactCollectionResult,
  EnvironmentBackend,
  EnvironmentCachePolicy,
  EnvironmentCleanupPolicy,
  EnvironmentController,
  EnvironmentHydrationResult,
  EnvironmentNetwork,
  EnvironmentPreflightResult,
  EnvironmentPrepareOptions,
  EnvironmentReconciliationResult,
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

const DEFAULT_ENVIRONMENT_NAME = 'local-process'
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_TTL_MS = 60 * 60 * 1000
const DEFAULT_CONTAINER_WORKDIR = '/workspace'
const SECRET_NAME_PATTERN = /(?:TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|COOKIE|AUTH)/i
const SENSITIVE_TEXT_FIELD_PATTERN = /(?:ERROR|REASON|MESSAGE|OUTPUT|STDERR|STDOUT|LOG|EVIDENCE|PAYLOAD)/i
const REMOTE_HOST_PROCESS_CONTROL_ENV_PATTERN = /^(?:PATH|HOME|SHELL|TMPDIR|TEMP|TMP|USER|LOGNAME|BASH_ENV|ENV|ZDOTDIR|IFS|CDPATH|SHELLOPTS|BASHOPTS|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|ELECTRON_RUN_AS_NODE|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|PYTHONHOME|PYTHONPATH|PYTHONSTARTUP|PYTHONINSPECT|PYTHONWARNINGS|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|GCONV_PATH|GLIBC_TUNABLES|OPENSSL_CONF|SSL_CERT_FILE|SSL_CERT_DIR|CURL_CA_BUNDLE|REQUESTS_CA_BUNDLE|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|HOSTALIASES|RES_OPTIONS|LOCALDOMAIN|GIT_SSH|GIT_SSH_COMMAND|SSH_AUTH_SOCK|AWS_PROFILE|AWS_CONFIG_FILE|AWS_SHARED_CREDENTIALS_FILE|GOOGLE_APPLICATION_CREDENTIALS|CLOUDSDK_CONFIG|DOCKER_CONFIG|KUBECONFIG|XDG_.+|LD_.+|DYLD_.+|CRABBOX_.+)$/
const SECRET_VALUE_PLACEHOLDER = '<secret-from-environment>'
const MAX_ENVIRONMENT_IDEMPOTENCY_KEY_LENGTH = 512
const localContainerWarmPools = new Map<string, { warmedAt: string; runtime: string; image: string; specHash: string }>()

export function clearLocalContainerWarmPoolsForTest(): void {
  localContainerWarmPools.clear()
}

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

function prepareLocalContainerEnvironment(spec: EnvironmentSpec, options: EnvironmentPrepareOptions = { taskId: 'unknown', stage: 'unknown' }): EnvironmentRunRecord {
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

function releaseLocalContainerEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  const workspace = typeof environment.metadata['workspaceHostPath'] === 'string' ? environment.metadata['workspaceHostPath'] : undefined
  if (workspace && isLocalContainerWorkspace(workspace)) fs.rmSync(path.dirname(workspace), { recursive: true, force: true })
  return releaseEnvironmentRun(environment)
}

function lookupLocalContainerEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
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

function releaseLocalContainerEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
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

function collectLocalContainerArtifacts(environment: EnvironmentRunRecord): EnvironmentArtifactCollectionResult {
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

function reconcileLocalContainerEnvironmentRuns(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult {
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

function prepareRemoteCrabboxEnvironment(spec: EnvironmentSpec, options: EnvironmentPrepareOptions = { taskId: 'unknown', stage: 'unknown' }): EnvironmentRunRecord {
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

function preflightRemoteCrabboxLease(spec: EnvironmentSpec, leaseId: string, base: EnvironmentPreflightResult): { preflight: EnvironmentPreflightResult; results: CrabboxCommandResult[] } {
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

function releaseRemoteCrabboxEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
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

function lookupMetadataEnvironmentAcquisition(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
  const key = normalizeEnvironmentIdempotencyKey(idempotencyKey)
  return {
    ok: true,
    found: false,
    backend: spec.backend,
    idempotencyKeyHash: environmentIdempotencyKeyHash(key),
    metadata: {},
    evidence: [`${spec.backend} has no external acquisition to look up by key`],
  }
}

function releaseMetadataEnvironmentAcquisition(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
  const key = normalizeEnvironmentIdempotencyKey(idempotencyKey)
  return {
    ok: true,
    found: false,
    released: false,
    backend: spec.backend,
    idempotencyKeyHash: environmentIdempotencyKeyHash(key),
    evidence: [`${spec.backend} has no external acquisition to release by key`],
  }
}

function lookupRemoteCrabboxEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult {
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

function releaseRemoteCrabboxEnvironmentByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult {
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

function releaseRemoteCrabboxLease(spec: EnvironmentSpec, leaseId: string): CrabboxCommandResult {
  let release = runCrabboxCli(spec, crabboxReleaseArgs(spec, leaseId, 'stop'), 'release')
  if (!release.ok && isUnknownCrabboxCommand(release.output)) {
    release = runCrabboxCli(spec, crabboxReleaseArgs(spec, leaseId, 'release'), 'release')
  }
  return release
}

export function finalizeEnvironmentRun(environment: EnvironmentRunRecord | undefined, success: boolean): EnvironmentRunRecord | undefined {
  if (!environment) return undefined
  const retain = success ? environment.cleanup.retainOnSuccess : environment.cleanup.retainOnFailure
  const controller = environmentControllerForBackend(environment.backend)
  try {
    return retain ? controller.retain(environment) : controller.release(environment)
  } catch (err: any) {
    return cleanupFailedEnvironmentRun(environment, err?.message || String(err))
  }
}

export function releaseEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  return updateEnvironmentLifecycle(environment, 'released', 'released')
}

export function retainEnvironmentRun(environment: EnvironmentRunRecord): EnvironmentRunRecord {
  return updateEnvironmentLifecycle(environment, 'retained', 'retained')
}

export function cleanupFailedEnvironmentRun(environment: EnvironmentRunRecord, reason: string): EnvironmentRunRecord {
  return {
    ...updateEnvironmentLifecycle(environment, 'cleanup_failed', 'failed'),
    metadata: { ...environment.metadata, cleanupError: shortText(reason, 500) },
  }
}

function updateEnvironmentLifecycle(environment: EnvironmentRunRecord, status: EnvironmentRunRecord['status'], state: EnvironmentRunRecord['cleanup']['state']): EnvironmentRunRecord {
  return {
    ...environment,
    status,
    updatedAt: new Date().toISOString(),
    cleanup: { ...environment.cleanup, state },
  }
}

function reconcileEnvironmentRuns(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult {
  const active = environments.filter(environment => environment.status === 'prepared' || environment.status === 'blocked')
  const retained = environments.filter(environment => environment.status === 'retained')
  const cleanupFailed = environments.filter(environment => environment.status === 'cleanup_failed')
  return {
    ok: cleanupFailed.length === 0,
    checked: environments.length,
    active: active.length,
    retained: retained.length,
    cleanupFailed: cleanupFailed.length,
    evidence: [`checked=${environments.length}`, `active=${active.length}`, `retained=${retained.length}`, `cleanupFailed=${cleanupFailed.length}`],
  }
}

export function environmentPromptContext(spec: EnvironmentSpec, run: EnvironmentRunRecord): string {
  const networkAllow = redactEnvironmentNetworkTargets(spec.network.allow || [])
  const lines = [
    'Execution environment contract:',
    `- Environment: ${spec.name} (${spec.backend})`,
    spec.workdir ? `- Workdir: ${spec.workdir}` : '',
    spec.tools.length ? `- Required tools declared for environment: ${spec.tools.join(', ')}` : '- Required tools declared for environment: none',
    `- Network policy: ${spec.network.mode}${networkAllow.length ? ` allow=${networkAllow.join(',')}` : ''}`,
    run.preflight.warnings.length ? `- Warnings: ${run.preflight.warnings.join('; ')}` : '',
  ]
  if (spec.backend === 'local-container') {
    const prefix = Array.isArray(run.metadata['commandPrefix']) ? run.metadata['commandPrefix'].map(String).join(' ') : `${spec.container?.runtime || 'docker'} run ... ${spec.container?.image || '(image not set)'}`
    lines.push(`- Run repository commands through the configured container runtime/image: ${spec.container?.runtime || 'docker'} ${spec.container?.image || '(image not set)'}`)
    lines.push(`- Container command prefix: ${prefix}`)
  }
  if (spec.backend === 'remote-crabbox') {
    const prefix = Array.isArray(run.metadata['commandPrefix']) ? run.metadata['commandPrefix'].map(String).join(' ') : `${spec.crabbox?.cli || 'crabbox'} run --id ${run.leaseId || '<lease-id>'} -- ...`
    lines.push(`- Remote Crabbox lease: ${run.leaseId || '(not leased)'}${run.metadata['slug'] ? ` slug=${run.metadata['slug']}` : ''}`)
    lines.push(`- Run repository commands through Crabbox so source sync, logs, timing, and artifacts stay attached to this lease.`)
    lines.push(`- Crabbox command prefix: ${prefix}`)
    lines.push(`- For multi-command shell snippets use: ${spec.crabbox?.cli || 'crabbox'} run --id ${run.leaseId || '<lease-id>'} --shell '<command>'`)
  }
  return lines.filter(Boolean).join('\n')
}

export function redactEnvironmentRecord<T>(value: T): T {
  return redact(value) as T
}

export function redactEnvironmentSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s'",)]+/gi, '<url:redacted>')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <redacted>')
    .replace(/\b(token|secret|password|api[_-]?key|authorization|bearer|webhook|chat[_ -]?id|phone)\s*[:=]\s*[^\s'",)]+/gi, '$1=<redacted>')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'",)]+/g, match => {
      if (/^https?:\/\//i.test(match)) return match
      return `<path:${hashText(path.resolve(match)).slice(0, 12)}>`
    })
}

export function redactEnvironmentNetworkTarget(value: string): string {
  const target = String(value || '').trim()
  if (!target) return ''
  try {
    const parsed = new URL(target)
    if (parsed.protocol && parsed.host) return `${parsed.protocol}//${parsed.host.toLowerCase()}`
  } catch {
    // Hostname, wildcard, and scp-like allow entries are not always valid URLs.
  }
  const withoutUserInfo = target.includes('@') ? target.slice(target.lastIndexOf('@') + 1) : target
  const head = withoutUserInfo.split(/[/?#]/)[0]!
  if (/^\[[0-9a-f:.]+\](?::\d{1,5})?$/i.test(head)) return head.toLowerCase()
  if (/^(\*\.)?[a-z0-9.-]+(?::\d{1,5})?$/i.test(head)) return head.toLowerCase()
  const scpLikeHost = head.match(/^([a-z0-9.-]+):[^:]+$/i)?.[1]
  if (scpLikeHost) return scpLikeHost.toLowerCase()
  const redacted = redactEnvironmentSensitiveText(head)
  return redacted === head ? `<network-target:${hashText(target).slice(0, 12)}>` : redacted
}

export function redactEnvironmentNetworkTargets(values: string[]): string[] {
  return uniqueStrings(values.map(redactEnvironmentNetworkTarget)).sort()
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

function createLocalContainerWorkspace(spec: EnvironmentSpec, options: { taskId: string; stage: string; idempotencyKey?: string }): string {
  const keyed = options.idempotencyKey ? localContainerWorkspaceTargetForKey(spec, options.idempotencyKey) : undefined
  const root = keyed?.root || path.join(os.tmpdir(), 'opencode-gateway', 'local-container', `${safePathPart(spec.name)}-${safePathPart(options.taskId)}-${safePathPart(options.stage)}-${randomUUID()}`)
  const workspace = path.join(root, 'workspace')
  if (keyed) fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(workspace, { recursive: true })
  if (spec.workdir && fs.existsSync(spec.workdir) && fs.statSync(spec.workdir).isDirectory()) fs.cpSync(spec.workdir, workspace, { recursive: true, dereference: false })
  return workspace
}

function localContainerWorkspaceTargetForKey(spec: EnvironmentSpec, idempotencyKey: string): { idempotencyKeyHash: string; root: string; workspace: string } {
  const idempotencyKeyHash = environmentIdempotencyKeyHash(idempotencyKey)
  const root = path.join(os.tmpdir(), 'opencode-gateway', 'local-container', `${safePathPart(spec.name)}-key-${idempotencyKeyHash}`)
  return { idempotencyKeyHash, root, workspace: path.join(root, 'workspace') }
}

function createLocalContainerCaptureDir(workspace: string): string {
  const dir = path.join(path.dirname(workspace), 'captures')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function createLocalContainerCommandWrapper(spec: EnvironmentSpec, workdir: string | undefined, captureDir: string): string {
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

function inspectLocalContainerImage(spec: EnvironmentSpec): { status: 'ok' | 'missing' | 'unavailable'; digest?: string; error?: string } {
  const runtime = spec.container?.runtime || 'docker'
  const image = spec.container?.image
  if (!image) return { status: 'missing', error: 'container image is not configured' }
  if (!binaryAvailable(runtime)) return { status: 'unavailable', error: `container runtime not found: ${runtime}` }
  const result = spawnSync(runtime, ['image', 'inspect', '--format', '{{.Id}}', image], { encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.status === 0) return { status: 'ok', digest: shortText(result.stdout.trim() || 'unknown', 300) }
  return { status: 'missing', error: shortText([result.stderr, result.stdout].filter(Boolean).join('\n') || `image inspect exited ${result.status}`, 500) }
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

function runCrabboxRemoteCommand(spec: EnvironmentSpec, leaseId: string, phase: string, command: string | string[]): CrabboxCommandResult {
  const args = crabboxRunArgs(spec, leaseId)
  if (Array.isArray(command)) args.push('--', ...command)
  else args.push('--shell', command)
  return runCrabboxCli(spec, args, phase)
}

function runCrabboxCli(spec: EnvironmentSpec, args: string[], phase: string): CrabboxCommandResult {
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

function runCrabboxReleaseCommand(cli: string, provider: string | undefined, leaseId: string, command: 'stop' | 'release'): CrabboxCommandResult {
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

function inspectRemoteCrabboxLease(spec: EnvironmentSpec, leaseId: string): { ok: true; record: Record<string, unknown> } | { ok: false; reason: string } {
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

function reconcileRemoteCrabboxEnvironmentRuns(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult {
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

function crabboxWarmupArgs(spec: EnvironmentSpec, idempotencyKey?: string): string[] {
  const args = ['warmup', '--timing-json']
  if (idempotencyKey) args.push('--slug', remoteCrabboxAcquisitionSlug(idempotencyKey))
  if (spec.crabbox?.profile) args.push('--profile', spec.crabbox.profile)
  if (spec.crabbox?.provider) args.push('--provider', spec.crabbox.provider)
  if (spec.crabbox?.class) args.push('--class', spec.crabbox.class)
  if (spec.crabbox?.ttl) args.push('--ttl', spec.crabbox.ttl)
  for (const volume of spec.cache.volumes) args.push('--cache-volume', `${volume.name}:${volume.path}`)
  return args
}

function crabboxReleaseArgs(spec: EnvironmentSpec, leaseId: string, command: 'stop' | 'release'): string[] {
  const args: string[] = [command]
  if (spec.crabbox?.provider) args.push('--provider', spec.crabbox.provider)
  args.push(leaseId)
  return args
}

function crabboxRunArgs(spec: EnvironmentSpec, leaseId: string): string[] {
  const args = ['run', '--id', leaseId, '--timing-json']
  if (spec.crabbox?.provider) args.push('--provider', spec.crabbox.provider)
  if (spec.crabbox?.keepOnFailure) args.push('--keep-on-failure')
  for (const name of crabboxAllowedEnvNames(spec)) args.push('--allow-env', name)
  return args
}

function remoteCrabboxCommandPrefix(spec: EnvironmentSpec, environment: Pick<EnvironmentRunRecord, 'leaseId'>): string[] {
  const leaseId = environment.leaseId || '<lease-id>'
  return [spec.crabbox?.cli || 'crabbox', ...crabboxRunArgs(spec, leaseId), '--']
}

function crabboxProcessEnv(spec: EnvironmentSpec): NodeJS.ProcessEnv {
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

function crabboxAllowedEnvNames(spec: EnvironmentSpec): string[] {
  return uniqueStrings([...Object.keys(spec.env), ...spec.secrets.allow])
}

function redactCrabboxText(text: string, spec: EnvironmentSpec): string {
  let out = text
  for (const name of crabboxAllowedEnvNames(spec)) {
    if (!SECRET_NAME_PATTERN.test(name) && !spec.secrets.allow.includes(name)) continue
    const value = process.env[name]
    if (value && value.length >= 4) out = out.split(value).join('<redacted>')
  }
  return out
}

function crabboxTimingRecord(output: string): Record<string, unknown> | undefined {
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

function crabboxLeaseId(result: CrabboxCommandResult): string | undefined {
  return stringField(result.timing, 'leaseId') || stringField(result.timing, 'lease_id') || result.stdout.match(/\b(cbx_[a-zA-Z0-9_-]+)/)?.[1] || result.output.match(/\b(cbx_[a-zA-Z0-9_-]+)/)?.[1]
}

function crabboxLeaseIdFromRecord(record: Record<string, unknown>): string | undefined {
  return stringField(record, 'id') || stringField(record, 'leaseId') || stringField(record, 'lease_id')
}

function crabboxSlug(result: CrabboxCommandResult): string | undefined {
  return stringField(result.timing, 'slug') || result.stdout.match(/\bslug=([^\s]+)/)?.[1] || result.output.match(/\bslug=([^\s]+)/)?.[1]
}

function crabboxRunId(result: CrabboxCommandResult): string | undefined {
  return stringField(result.timing, 'runId') || stringField(result.timing, 'run_id')
}

function crabboxArtifacts(timing: Record<string, unknown> | undefined): string[] {
  if (!timing) return []
  const values = [timing['artifacts'], timing['artifactRefs'], timing['artifact_refs'], timing['captures'], timing['downloads']]
  const refs: string[] = []
  for (const value of values) {
    if (Array.isArray(value)) refs.push(...value.map(item => typeof item === 'string' ? item : stableStringifyDefined(item)))
    else if (typeof value === 'string') refs.push(value)
  }
  return uniqueStrings(refs.map(ref => shortText(ref, 500)))
}

function crabboxCommandSummary(result: CrabboxCommandResult): Record<string, unknown> {
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

function crabboxCommandRef(cli: string, args: string[]): string {
  return [cli, ...args].join(' ')
}

function classifyCrabboxFailure(output: string, phase: string, timing: Record<string, unknown> | undefined, timedOut = false): CrabboxCommandResult['failureClass'] {
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

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = (value as Record<string, unknown>)[key]
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

function isUnknownCrabboxCommand(output: string): boolean {
  return /unknown command|unrecognized command|not a crabbox command/i.test(output)
}

function isMissingCrabboxLease(output: string): boolean {
  return /\b(not found|no such|unknown lease|missing lease|does not exist|404)\b/i.test(output)
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

function preflightLocalContainerStageCommands(spec: EnvironmentSpec, base: EnvironmentPreflightResult): { preflight: EnvironmentPreflightResult; results: LocalContainerCommandResult[] } {
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

function runLocalContainerShellCommand(spec: EnvironmentSpec, command: string, workdir: string | undefined, phase: string): LocalContainerCommandResult {
  return runLocalContainerCommand(spec, ['sh', '-lc', command], workdir, phase)
}

function runLocalContainerCommand(spec: EnvironmentSpec, command: string[], workdir: string | undefined, phase = 'command'): LocalContainerCommandResult {
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

function localContainerCommandSummary(result: LocalContainerCommandResult): Record<string, unknown> {
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

function localContainerCommandRef(runtime: string, args: string[]): string {
  return [runtime, ...args].join(' ')
}

function warmLocalContainerPool(spec: EnvironmentSpec, workdir: string | undefined): { enabled: false } | { enabled: true; key: string; hit: boolean; warmedAt?: string; result?: LocalContainerCommandResult } {
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

function redactLocalContainerText(text: string, spec: EnvironmentSpec): string {
  let out = text
  for (const name of uniqueStrings([...Object.keys(spec.env), ...spec.secrets.allow])) {
    const value = process.env[name]
    if (value && value.length >= 4) out = out.split(value).join('<redacted>')
  }
  return out
}

function localContainerCommandPrefix(spec: EnvironmentSpec, workdir: string | undefined): string[] {
  return [spec.container?.runtime || 'docker', ...localContainerRunArgs(spec, workdir, [])]
}

function localContainerRunArgs(spec: EnvironmentSpec, workdir: string | undefined, command: string[]): string[] {
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

function localContainerNetworkArgs(spec: EnvironmentSpec): string[] {
  assertContainerNetworkPolicy(spec)
  if (spec.network.mode === 'disabled' || spec.network.mode === 'restricted') return ['--network', 'none']
  return spec.container?.network ? ['--network', spec.container.network] : []
}

function localContainerWorkdir(spec: EnvironmentSpec): string {
  return spec.container?.workdir || DEFAULT_CONTAINER_WORKDIR
}

function localContainerCacheVolumes(spec: EnvironmentSpec): Array<{ name: string; target: string; mode: 'readonly' | 'readwrite' }> {
  return spec.cache.volumes.map(volume => ({ name: `opencode-gateway-${hashText(`${spec.specHash}:${volume.name}`).slice(0, 16)}-${safePathPart(volume.name)}`, target: volume.path, mode: volume.mode || 'readwrite' }))
}

function readLocalContainerCaptures(captureDir: string | undefined): Array<Record<string, any> & { metadataPath: string }> {
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

function localContainerWorkspaceArtifacts(workspace: string | undefined): string[] {
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

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]+/g, '-').slice(0, 80) || 'item'
}

function isLocalContainerWorkspace(workspace: string): boolean {
  const root = path.join(os.tmpdir(), 'opencode-gateway', 'local-container')
  const relative = path.relative(root, workspace)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeEnvironmentIdempotencyKey(value: string): string {
  const key = String(value || '').trim()
  if (!key || key.length > MAX_ENVIRONMENT_IDEMPOTENCY_KEY_LENGTH || /[\0\r\n]/.test(key)) {
    throw new Error(`environment acquisition idempotency key must be 1-${MAX_ENVIRONMENT_IDEMPOTENCY_KEY_LENGTH} printable characters`)
  }
  return key
}

function environmentIdempotencyKeyHash(value: string): string {
  return hashText(normalizeEnvironmentIdempotencyKey(value)).slice(0, 24)
}

export function remoteCrabboxAcquisitionSlug(idempotencyKey: string): string {
  return `ogw-${hashText(normalizeEnvironmentIdempotencyKey(idempotencyKey)).slice(0, 32)}`
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

function binaryAvailable(binary: string): boolean {
  if (path.isAbsolute(binary)) {
    try {
      fs.accessSync(binary, fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }
  const paths = (process.env['PATH'] || '').split(path.delimiter).filter(Boolean)
  const extensions = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  return paths.some(dir => extensions.some(ext => {
    try {
      fs.accessSync(path.join(dir, binary + ext), fs.constants.X_OK)
      return true
    } catch {
      return false
    }
  }))
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

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set((values || []).map(value => String(value || '').trim()).filter(Boolean))].sort()
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return number
}

function boundedNumber(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} must be a number between ${min} and ${max}`)
  return number
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('environment text field must be a string')
  const text = value.trim()
  return text ? text.substring(0, maxLength) : undefined
}

function normalizeRuntimeExecutable(value: unknown, label: string): string | undefined {
  const text = optionalText(value, 1024)
  if (!text) return undefined
  if (text.includes('\0') || /[\r\n]/.test(text)) throw new Error(`${label} must be one executable path or command name`)
  return text
}

function shortText(value: unknown, maxLength: number): string {
  return String(value || '').replace(/\s+/g, ' ').trim().substring(0, maxLength)
}

function durationMs(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'number') return boundedInteger(value, 1000, 30 * 24 * 60 * 60 * 1000, 'duration')
  const match = String(value).trim().match(/^(\d+)(ms|s|m|h|d)$/i)
  if (!match) throw new Error(`duration must use ms, s, m, h, or d suffix: ${String(value)}`)
  const amount = Number(match[1])
  const unit = match[2]!.toLowerCase()
  const multiplier = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
  return boundedInteger(amount * multiplier, 1000, 30 * 24 * 60 * 60 * 1000, 'duration')
}


function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_NAME_PATTERN.test(key)) out[key] = '<redacted>'
    else if (SENSITIVE_TEXT_FIELD_PATTERN.test(key)) out[key] = redactSensitiveValue(val)
    else out[key] = redact(val)
  }
  return out
}

function redactSensitiveValue(value: unknown): unknown {
  if (typeof value === 'string') return redactEnvironmentSensitiveText(value)
  if (Array.isArray(value)) return value.map(redactSensitiveValue)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_NAME_PATTERN.test(key) ? '<redacted>' : redactSensitiveValue(val)
  }
  return out
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
