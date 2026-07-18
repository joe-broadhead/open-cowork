import * as os from 'node:os'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { createHash } from 'node:crypto'
import { redactEnvironmentNetworkTargets, redactEnvironmentSensitiveText, type EnvironmentRunRecord, type EnvironmentSpec } from './environments.js'
import { summarizeRuntimeCapabilityGrant, type RuntimeCapabilityGrant, type RuntimeCapabilityGrantSummary } from './runtime-capability-grants.js'

export interface RuntimeIsolationReviewGate {
  active: boolean
  deniedTools: string[]
  allowedBashCommandCount: number
  forbiddenPathHints: string[]
  changedPermissions: string[]
}

export interface RuntimeIsolationProfileAccess {
  tools: string[]
  mcpServers: string[]
  skills: string[]
  capabilities: string[]
}

export interface RuntimeIsolationProfile {
  version: 1
  id: string
  taskId: string
  stage: string
  profile: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  environment: {
    name: string
    backend: EnvironmentSpec['backend']
    specHash: string
    runId?: string
    runtime?: string
    image?: string
    provider?: string
    class?: string
  }
  cwd: {
    source: 'attachment' | 'environment' | 'task' | 'none'
    redacted: string
  }
  filesystem: {
    policy: 'local-workdir' | 'container-workspace' | 'remote-lease' | 'custom'
    workdir: string
    mounts: Array<{ target: string; mode: 'readonly' | 'readwrite'; source?: string }>
  }
  network: {
    mode: EnvironmentSpec['network']['mode']
    allow: string[]
  }
  process: {
    timeoutMs: number
    ttlMs: number
    cleanup: {
      retainOnFailure: boolean
      retainOnSuccess: boolean
      state: EnvironmentRunRecord['cleanup']['state']
      status: EnvironmentRunRecord['status']
    }
  }
  permissions: {
    source: string
    summary: string
    access: RuntimeIsolationProfileAccess
    reviewGate?: RuntimeIsolationReviewGate
  }
  tools: {
    required: string[]
    checked: string[]
    missing: string[]
  }
  secrets: {
    allowedNames: string[]
    count: number
  }
  capabilityGrant?: RuntimeCapabilityGrant
  validation: RuntimeIsolationValidation
  createdAt: string
}

export interface RuntimeIsolationProfileSummary {
  id: string
  version: 1
  taskId: string
  stage: string
  profile: string
  agent?: string
  model?: { providerID?: string; modelID?: string }
  environment: RuntimeIsolationProfile['environment']
  cwd: RuntimeIsolationProfile['cwd']
  filesystem: RuntimeIsolationProfile['filesystem']
  network: RuntimeIsolationProfile['network']
  process: RuntimeIsolationProfile['process']
  permissions: RuntimeIsolationProfile['permissions']
  tools: RuntimeIsolationProfile['tools']
  secrets: RuntimeIsolationProfile['secrets']
  capabilityGrant?: RuntimeCapabilityGrantSummary
  validation: RuntimeIsolationValidation
  lifecycleDiagnostics: RuntimeLifecycleDiagnostic[]
  createdAt: string
}

export interface RuntimeIsolationValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
}

export type RuntimeLifecycleDiagnosticSeverity = 'info' | 'warning' | 'critical'
export type RuntimeLifecycleDiagnosticCode =
  | 'preflight_blocked'
  | 'stale_active_environment'
  | 'retained_resource'
  | 'cleanup_failed'
  | 'abandoned_workspace'
  | 'missing_workspace'
  | 'missing_artifact'
  | 'custom_backend_preview'

export interface RuntimeLifecycleDiagnostic {
  id: string
  severity: RuntimeLifecycleDiagnosticSeverity
  code: RuntimeLifecycleDiagnosticCode
  environmentId: string
  backend: EnvironmentRunRecord['backend']
  status: EnvironmentRunRecord['status']
  cleanupState: EnvironmentRunRecord['cleanup']['state']
  summary: string
  action: string
  ageMs?: number
  evidence: string[]
}

export interface RuntimeLifecycleDiagnosticOptions {
  now?: Date
  staleMs?: number
}

export interface RuntimeIsolationBuildInput {
  taskId: string
  stage: string
  profileName: string
  agentName?: string
  model?: unknown
  permissionSummary?: string
  profileAccess?: Partial<RuntimeIsolationProfileAccess>
  environmentSpec: EnvironmentSpec
  environmentRun: EnvironmentRunRecord
  requestedWorkdir?: string
  attachmentWorkdir?: string
  reviewGate?: RuntimeIsolationReviewGate
  capabilityGrant?: RuntimeCapabilityGrant
  now?: Date
}

export function validateRuntimeIsolationSpec(spec: EnvironmentSpec): RuntimeIsolationValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const custom = spec.custom || {}
  if (custom['runtimeIsolation'] === 'unsafe' || custom['unsafeRuntimeIsolation'] === true) {
    errors.push(`runtime isolation for environment ${spec.name} is explicitly marked unsafe`)
  }
  const wildcardNetworkAllows = (spec.network.allow || []).filter(value => ['*', '0.0.0.0/0', '::/0'].includes(value))
  if (wildcardNetworkAllows.length) errors.push(`runtime network allowlist contains wildcard entries: ${wildcardNetworkAllows.join(', ')}`)
  if (spec.network.mode !== 'restricted' && spec.network.allow?.length) {
    errors.push(`runtime network allowlist requires network.mode=restricted`)
  }
  if (spec.backend !== 'local-container' && spec.network.mode !== 'unrestricted') warnings.push(`runtime network mode ${spec.network.mode} is declarative and not enforced by backend ${spec.backend}`)
  if (spec.backend === 'local-container') {
    const containerNetwork = spec.container?.network
    if ((spec.network.mode === 'disabled' || spec.network.mode === 'restricted') && containerNetwork && containerNetwork !== 'none') {
      errors.push(`runtime network mode ${spec.network.mode} conflicts with container network ${containerNetwork}`)
    }
    if (spec.network.mode === 'restricted' && spec.network.allow?.length) {
      errors.push('runtime network allowlist has no configured enforcement mechanism for local-container')
    }
  }
  if (spec.workdir) {
    const workdir = canonicalRuntimePath(spec.workdir)
    if (isFilesystemRoot(workdir)) errors.push(`runtime workdir for environment ${spec.name} may not be filesystem root`)
    else if (isSensitiveHostPath(workdir)) errors.push(`runtime workdir for environment ${spec.name} may not be a sensitive host path`)
  }
  if (spec.backend === 'custom' && custom['runtimeIsolation'] !== 'declared') {
    warnings.push(`custom environment ${spec.name} should declare custom.runtimeIsolation=\"declared\" before public release`)
  }
  if (spec.backend === 'local-process' && spec.network.mode === 'unrestricted') {
    warnings.push('local-process environment has unrestricted network access')
  }
  if (spec.backend === 'local-container') {
    for (const mount of spec.container?.mounts || []) {
      const reason = validateHostContainerMountSource(mount.source, spec)
      if (reason) errors.push(`container mount ${mount.source} -> ${mount.target} is not allowed: ${reason}`)
    }
  }
  if (spec.secrets.allow.length && Object.keys(spec.env).length === 0) {
    warnings.push('secret names are allowed but no explicit environment variables are declared')
  }
  return { ok: errors.length === 0, errors, warnings }
}

function validateHostContainerMountSource(source: string, spec: EnvironmentSpec): string | undefined {
  const resolved = canonicalRuntimePath(source)
  if (isFilesystemRoot(resolved)) return 'host filesystem root may not be mounted'
  if (isSensitiveHostPath(resolved)) return 'sensitive host path'
  const allowedRoots = [spec.workdir, process.cwd(), os.tmpdir()].filter((value): value is string => Boolean(value)).map(canonicalRuntimePath)
  if (allowedRoots.some(root => isPathWithin(resolved, root))) return undefined
  return `mount source must be under ${allowedRoots.map(redactRuntimePath).join(', ')}`
}

function isSensitiveHostPath(source: string): boolean {
  const candidate = canonicalRuntimePath(source)
  const home = canonicalRuntimePath(os.homedir())
  if (candidate === home) return true
  const sensitiveTrees = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.kube'),
    path.join(home, '.config'),
    ...(process.platform === 'win32' ? [] : ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run']),
  ].map(canonicalRuntimePath)
  return sensitiveTrees.some(root => isPathWithin(candidate, root))
}

function canonicalRuntimePath(value: string): string {
  const resolved = path.resolve(value)
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

function isPathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative))
}

export function buildRuntimeIsolationProfile(input: RuntimeIsolationBuildInput): RuntimeIsolationProfile {
  const specValidation = validateRuntimeIsolationSpec(input.environmentSpec)
  const errors = [...specValidation.errors]
  const warnings = [...specValidation.warnings]
  if (!input.environmentRun.preflight.ok) errors.push(`runtime preflight failed: missing ${input.environmentRun.preflight.missing.join(', ') || 'unknown tool'}`)
  warnings.push(...input.environmentRun.preflight.warnings)
  const cwd = runtimeCwd(input.attachmentWorkdir, input.environmentSpec.workdir, input.requestedWorkdir)
  const id = runtimeProfileId(input.taskId, input.stage, input.profileName, input.environmentSpec.specHash, input.environmentRun.id)
  const model = modelSummary(input.model)
  return {
    version: 1,
    id,
    taskId: input.taskId,
    stage: input.stage,
    profile: input.profileName,
    agent: input.agentName,
    model,
    environment: {
      name: input.environmentSpec.name,
      backend: input.environmentSpec.backend,
      specHash: input.environmentSpec.specHash,
      runId: input.environmentRun.id,
      runtime: redactRuntimePath(input.environmentRun.runtime),
      image: input.environmentRun.image,
      provider: input.environmentRun.provider,
      class: input.environmentRun.class,
    },
    cwd,
    filesystem: runtimeFilesystem(input.environmentSpec, cwd.redacted),
    network: {
      mode: input.environmentSpec.network.mode,
      allow: redactEnvironmentNetworkTargets(input.environmentSpec.network.allow || []),
    },
    process: {
      timeoutMs: input.environmentSpec.resources.timeoutMs,
      ttlMs: input.environmentRun.ttlMs,
      cleanup: cleanupSummary(input.environmentRun),
    },
    permissions: {
      source: input.reviewGate?.active ? 'review-gate-isolation' : 'profile',
      summary: input.permissionSummary || (input.reviewGate?.active ? 'review gate isolation enforced' : 'profile permissions'),
      access: normalizeProfileAccess(input.profileAccess),
      reviewGate: redactReviewGate(input.reviewGate),
    },
    tools: {
      required: [...input.environmentSpec.tools].sort(),
      checked: [...input.environmentRun.preflight.checked].sort(),
      missing: [...input.environmentRun.preflight.missing].sort(),
    },
    secrets: {
      allowedNames: [...input.environmentRun.secrets.allowedNames].sort(),
      count: input.environmentRun.secrets.allowedNames.length,
    },
    capabilityGrant: input.capabilityGrant,
    validation: { ok: errors.length === 0, errors, warnings: uniqueStrings(warnings) },
    createdAt: (input.now || new Date()).toISOString(),
  }
}

export function summarizeRuntimeIsolationProfile(profile: RuntimeIsolationProfile | undefined, environment?: EnvironmentRunRecord): RuntimeIsolationProfileSummary | undefined {
  if (!profile) return undefined
  const cleanup = environment ? cleanupSummary(environment) : profile.process.cleanup
  const lifecycleDiagnostics = environment ? buildRuntimeLifecycleDiagnostics(environment) : []
  return {
    id: profile.id,
    version: profile.version,
    taskId: profile.taskId,
    stage: profile.stage,
    profile: profile.profile,
    agent: profile.agent,
    model: profile.model,
    environment: profile.environment,
    cwd: profile.cwd,
    filesystem: profile.filesystem,
    network: profile.network,
    process: { ...profile.process, cleanup },
    permissions: profile.permissions,
    tools: profile.tools,
    secrets: profile.secrets,
    capabilityGrant: summarizeRuntimeCapabilityGrant(profile.capabilityGrant),
    validation: profile.validation,
    lifecycleDiagnostics,
    createdAt: profile.createdAt,
  }
}

export function buildRuntimeLifecycleDiagnostics(environment: EnvironmentRunRecord, options: RuntimeLifecycleDiagnosticOptions = {}): RuntimeLifecycleDiagnostic[] {
  const nowMs = (options.now || new Date()).getTime()
  const updatedMs = Date.parse(environment.updatedAt || environment.startedAt || '')
  const ageMs = Number.isFinite(updatedMs) ? Math.max(0, nowMs - updatedMs) : undefined
  const staleMs = options.staleMs ?? Math.max(environment.ttlMs || 0, 5 * 60 * 1000)
  const diagnostics: RuntimeLifecycleDiagnostic[] = []

  if (environment.status === 'blocked') {
    diagnostics.push(runtimeDiagnostic(environment, 'critical', 'preflight_blocked', 'Environment start is blocked before OpenCode session creation.', 'Fix missing tools or environment preflight warnings, then retry the task.', [
      `missing=${environment.preflight.missing.join(',') || 'unknown'}`,
      ...environment.preflight.warnings.slice(0, 3),
    ], ageMs))
  }

  if ((environment.status === 'prepared' || environment.status === 'blocked') && ageMs !== undefined && ageMs > staleMs) {
    diagnostics.push(runtimeDiagnostic(environment, 'warning', 'stale_active_environment', 'Environment is still active past its lifecycle window.', 'Run environment_reconcile and recover or retry the owning task if the OpenCode session is missing.', [
      `ageMs=${ageMs}`,
      `staleAfterMs=${staleMs}`,
    ], ageMs))
  }

  if (environment.status === 'retained' && ageMs !== undefined && ageMs > staleMs) {
    diagnostics.push(runtimeDiagnostic(environment, 'warning', 'retained_resource', 'Retained environment has exceeded its inspection window.', 'Release or clean up the retained environment after evidence is collected.', [
      `ageMs=${ageMs}`,
      `staleAfterMs=${staleMs}`,
    ], ageMs))
  }

  if (environment.status === 'cleanup_failed') {
    diagnostics.push(runtimeDiagnostic(environment, 'critical', 'cleanup_failed', 'Environment cleanup failed and requires operator action.', 'Inspect the redacted cleanup error, fix the backend/resource issue, then rerun cleanup.', [
      `cleanupError=${String(environment.metadata?.['cleanupError'] || 'unknown cleanup failure')}`,
    ], ageMs))
  }

  if (environment.backend === 'custom') {
    diagnostics.push(runtimeDiagnostic(environment, 'info', 'custom_backend_preview', 'Custom runtime backends are preview-only unless their isolation contract is declared and reviewed.', 'Keep custom runtimes out of release claims or replace them with local-process, local-container, or an approved remote preview backend.', [
      'backend=custom',
    ], ageMs))
  }

  diagnostics.push(...workspaceDiagnostics(environment, ageMs))
  diagnostics.push(...artifactDiagnostics(environment, ageMs))
  return diagnostics
}

export function runtimeIsolationPromptContext(profile: RuntimeIsolationProfile): string {
  const lines = [
    'Runtime isolation contract:',
    `- Runtime profile: ${profile.id}`,
    profile.capabilityGrant ? `- Capability grant: ${profile.capabilityGrant.id} (${profile.capabilityGrant.status})` : '',
    `- Environment: ${profile.environment.name} (${profile.environment.backend})`,
    `- CWD: ${profile.cwd.redacted}`,
    `- Filesystem policy: ${profile.filesystem.policy}`,
    `- Network policy: ${profile.network.mode}${profile.network.allow.length ? ` allow=${profile.network.allow.join(',')}` : ''}`,
    `- Timeout: ${profile.process.timeoutMs}ms; cleanup ttl: ${profile.process.ttlMs}ms`,
    profile.tools.required.length ? `- Required tools: ${profile.tools.required.join(', ')}` : '- Required tools: none declared',
    profile.secrets.count ? `- Secret names allowed: ${profile.secrets.allowedNames.join(', ')}` : '- Secret names allowed: none',
    profile.validation.warnings.length ? `- Runtime warnings: ${profile.validation.warnings.join('; ')}` : '',
  ]
  return lines.filter(Boolean).join('\n')
}

export function redactRuntimePath(value: string | undefined): string | undefined {
  if (!value) return value
  if (value.startsWith('~') || value.startsWith('<tmp>') || value.startsWith('<path:')) return value
  if (!path.isAbsolute(value)) return value
  const resolved = path.resolve(value)
  const home = path.resolve(os.homedir())
  const tmp = path.resolve(os.tmpdir())
  if (resolved === home) return '~'
  if (isSubpath(resolved, home)) return `~/${path.relative(home, resolved)}`
  if (resolved === tmp) return '<tmp>'
  if (isSubpath(resolved, tmp)) return `<tmp>/${path.relative(tmp, resolved)}`
  return `<path:${hashText(resolved)}>${path.sep}${path.basename(resolved)}`
}

function runtimeProfileId(taskId: string, stage: string, profileName: string, specHash: string, environmentRunId: string): string {
  return `runtime_${hashText([taskId, stage, profileName, specHash, environmentRunId].join(':')).slice(0, 16)}`
}

function runtimeCwd(attachmentWorkdir: string | undefined, environmentWorkdir: string | undefined, requestedWorkdir: string | undefined): RuntimeIsolationProfile['cwd'] {
  const raw = attachmentWorkdir || environmentWorkdir || requestedWorkdir
  const source = attachmentWorkdir ? 'attachment' : environmentWorkdir ? 'environment' : requestedWorkdir ? 'task' : 'none'
  return { source, redacted: redactRuntimePath(raw) || '(not set)' }
}

function runtimeFilesystem(spec: EnvironmentSpec, redactedWorkdir: string): RuntimeIsolationProfile['filesystem'] {
  if (spec.backend === 'local-container') {
    return {
      policy: 'container-workspace',
      workdir: redactRuntimePath(spec.container?.workdir || redactedWorkdir) || redactedWorkdir,
      mounts: (spec.container?.mounts || []).map(mount => ({
        target: mount.target,
        mode: mount.readonly ? 'readonly' : 'readwrite',
        source: redactRuntimePath(mount.source),
      })),
    }
  }
  if (spec.backend === 'remote-crabbox') return { policy: 'remote-lease', workdir: redactedWorkdir, mounts: [] }
  if (spec.backend === 'custom') return { policy: 'custom', workdir: redactedWorkdir, mounts: [] }
  return { policy: 'local-workdir', workdir: redactedWorkdir, mounts: [] }
}

function cleanupSummary(environment: EnvironmentRunRecord): RuntimeIsolationProfile['process']['cleanup'] {
  return {
    retainOnFailure: environment.cleanup.retainOnFailure,
    retainOnSuccess: environment.cleanup.retainOnSuccess,
    state: environment.cleanup.state,
    status: environment.status,
  }
}

function workspaceDiagnostics(environment: EnvironmentRunRecord, ageMs: number | undefined): RuntimeLifecycleDiagnostic[] {
  const workspace = typeof environment.metadata?.['workspaceHostPath'] === 'string' ? environment.metadata['workspaceHostPath'] : undefined
  if (!workspace) return []
  const exists = fs.existsSync(workspace)
  if (environment.status === 'released' && exists) {
    return [runtimeDiagnostic(environment, 'critical', 'abandoned_workspace', 'Released environment still has a workspace on disk.', 'Run environment cleanup or remove the backend-managed workspace after confirming no active run owns it.', [`workspace=${workspace}`], ageMs)]
  }
  if ((environment.status === 'prepared' || environment.status === 'blocked' || environment.status === 'retained') && !exists) {
    return [runtimeDiagnostic(environment, 'warning', 'missing_workspace', 'Environment metadata points at a workspace that no longer exists.', 'Treat the run as orphaned or stale; reconcile the environment and retry from durable state.', [`workspace=${workspace}`], ageMs)]
  }
  return []
}

function artifactDiagnostics(environment: EnvironmentRunRecord, ageMs: number | undefined): RuntimeLifecycleDiagnostic[] {
  const missing = environment.artifacts
    .filter(ref => ref.startsWith('file:'))
    .map(ref => ref.slice('file:'.length))
    .filter(filePath => path.isAbsolute(filePath) && !fs.existsSync(filePath))
  if (!missing.length) return []
  return [runtimeDiagnostic(environment, 'warning', 'missing_artifact', 'Environment evidence references missing local artifact files.', 'Regenerate or mark the evidence bundle incomplete before using this run as proof.', missing.slice(0, 5).map(filePath => `missingArtifact=${filePath}`), ageMs)]
}

function runtimeDiagnostic(
  environment: EnvironmentRunRecord,
  severity: RuntimeLifecycleDiagnosticSeverity,
  code: RuntimeLifecycleDiagnosticCode,
  summary: string,
  action: string,
  evidence: string[],
  ageMs?: number,
): RuntimeLifecycleDiagnostic {
  return {
    id: `runtime.${environment.id}.${code}`,
    severity,
    code,
    environmentId: environment.id,
    backend: environment.backend,
    status: environment.status,
    cleanupState: environment.cleanup.state,
    summary,
    action,
    ageMs,
    evidence: evidence.map(redactEnvironmentSensitiveText),
  }
}

function modelSummary(model: unknown): RuntimeIsolationProfile['model'] | undefined {
  if (!model || typeof model !== 'object') return undefined
  const record = model as Record<string, unknown>
  return {
    providerID: typeof record['providerID'] === 'string' ? record['providerID'] : undefined,
    modelID: typeof record['modelID'] === 'string' ? record['modelID'] : undefined,
  }
}

function normalizeProfileAccess(access: Partial<RuntimeIsolationProfileAccess> | undefined): RuntimeIsolationProfileAccess {
  return {
    tools: uniqueStrings(access?.tools || []).sort(),
    mcpServers: uniqueStrings(access?.mcpServers || []).sort(),
    skills: uniqueStrings(access?.skills || []).sort(),
    capabilities: uniqueStrings(access?.capabilities || []).sort(),
  }
}

function redactReviewGate(reviewGate: RuntimeIsolationReviewGate | undefined): RuntimeIsolationReviewGate | undefined {
  if (!reviewGate) return undefined
  return {
    ...reviewGate,
    forbiddenPathHints: reviewGate.forbiddenPathHints.map(hint => redactRuntimePath(hint) || hint),
  }
}

function isFilesystemRoot(value: string): boolean {
  const parsed = path.parse(path.resolve(value))
  return path.resolve(value) === parsed.root
}

function isSubpath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}
