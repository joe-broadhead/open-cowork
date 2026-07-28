import type { OpenCoworkConfig } from '@open-cowork/shared'
import type { OpencodeRuntimeConfig } from '@open-cowork/runtime-host/runtime-config-builder'
import type { CloudDeploymentTier, CloudRuntimePolicy } from './cloud-config.ts'
import type { CloudObservabilityAdapter } from './observability.ts'
import type { PathProvider } from './path-provider.ts'
import type {
  CloudRuntimeAdapter,
  CloudRuntimeExecutionContext,
} from './runtime-adapter.ts'
import type {
  SandboxComponentManifest,
  SandboxEngine,
  SandboxRuntimeCommandRunner,
  SandboxRuntimeResourceLimits,
} from './runtime-portability.ts'

type Env = Record<string, string | undefined>

export const CLOUD_EXECUTION_ISOLATION_ERROR_CODE = 'cloud_execution_isolation_unavailable'
export const CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT = 'open-cowork-cloud-execution-isolation-v1'

export type CloudExecutionIsolationMode =
  | 'development-process'
  | 'sandbox'
  | 'external-provider'
export type CloudExecutionNetworkPolicy =
  | { kind: 'deny-all' }
  | {
    kind: 'restricted'
    networkName: string
    policyId: string
  }

export type CloudExecutionIsolationPolicy = {
  required: boolean
  mode: CloudExecutionIsolationMode
  deploymentTier: CloudDeploymentTier
  engine: SandboxEngine | null
  opencodeCommand: string | null
  imageComponentId: string | null
  componentManifest: SandboxComponentManifest | null
  network: CloudExecutionNetworkPolicy
  blockers: string[]
  warning: string | null
}

export type CloudExecutionIsolationCapability = {
  provider: string
  available: boolean
  verified: boolean
  engine: SandboxEngine | 'host-process' | 'external'
  processIsolation: 'container' | 'external-boundary' | 'shared-host'
  userIsolation: 'container-user' | 'external-identity' | 'shared-worker'
  mountScope: 'execution' | 'unverified'
  runtimeHomeScope: 'execution' | 'unverified'
  descendantCleanup: 'container-init' | 'provider-owned' | 'best-effort'
  networkPolicy: 'deny-all' | 'restricted' | 'unverified'
  reasonCode: string
}

export type CloudExecutionIsolationAttestation = CloudExecutionIsolationCapability & {
  format: typeof CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT
  boundaryId: string
  establishedAt: string
}

export type CloudExecutionProvisionInput = {
  paths: PathProvider
  policy: CloudRuntimePolicy
  env: Env
  config: OpenCoworkConfig
  execution: CloudRuntimeExecutionContext
  runtimeConfig: OpencodeRuntimeConfig | undefined
  signal?: AbortSignal
  onUnexpectedExit?: () => void
}

export type CloudExecutionBoundary = {
  adapter: CloudRuntimeAdapter
  attestation: CloudExecutionIsolationAttestation
  close(): Promise<void>
}

export type CloudExecutionProvisionPreparation = {
  /**
   * Releases an unconsumed preparation. Providers must make this idempotent:
   * provision() consumes it, while callers use release() when pre-provision
   * work such as checkpoint restore fails.
   */
  release(): Promise<void>
}

export type CloudExecutionIsolationProvider = {
  name: string
  capability(): Promise<CloudExecutionIsolationCapability>
  prepareProvision?(
    input: CloudExecutionProvisionInput,
  ): Promise<CloudExecutionProvisionPreparation>
  provision(input: CloudExecutionProvisionInput): Promise<CloudExecutionBoundary>
  close?(): Promise<void>
}

export type SandboxWorkerOwnerLease = {
  claim(): Promise<{
    owned: boolean
    reasonCode: string
  }>
  close(): Promise<void>
}

export function resolveCloudExecutionWorkerId(input: {
  deploymentTier: CloudDeploymentTier
  role: CloudRuntimePolicy['role']
  isolationMode: CloudExecutionIsolationMode
  env: Env
}) {
  const raw = input.env.OPEN_COWORK_CLOUD_WORKER_ID
  const configured = raw?.trim()
  if (configured) {
    if (
      raw !== configured
      || configured.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(configured)
    ) {
      throw new CloudExecutionIsolationError(
        'cloud_worker_id_invalid',
        'OPEN_COWORK_CLOUD_WORKER_ID must be 1-128 ASCII letters, digits, dots, underscores, or dashes.',
      )
    }
    return {
      workerId: configured,
      usedDevelopmentFallback: false,
    }
  }
  if (
    input.isolationMode !== 'development-process'
    || input.deploymentTier === 'public_production'
  ) {
    throw new CloudExecutionIsolationError(
      'cloud_worker_id_missing',
      'Isolated Cloud execution requires an explicit OPEN_COWORK_CLOUD_WORKER_ID.',
    )
  }
  return {
    workerId: `${input.role}-worker`,
    usedDevelopmentFallback: true,
  }
}

export type CloudIsolationControlBridge = {
  url: string
  close(): Promise<void>
}

export type CloudSandboxResourceLimits = Required<SandboxRuntimeResourceLimits>

export const DEFAULT_CLOUD_SANDBOX_RESOURCE_LIMITS: CloudSandboxResourceLimits = {
  memoryBytes: 2 * 1024 * 1024 * 1024,
  cpuCount: 2,
  pids: 512,
}

function sandboxResourceLimitValue(env: Env, key: string) {
  const value = env[key]?.trim()
  return value ? Number(value) : null
}

export function resolveCloudSandboxResourceLimits(
  env: Env,
): CloudSandboxResourceLimits {
  const memoryBytes = sandboxResourceLimitValue(
    env,
    'OPEN_COWORK_CLOUD_ISOLATION_MEMORY_LIMIT_BYTES',
  ) ?? DEFAULT_CLOUD_SANDBOX_RESOURCE_LIMITS.memoryBytes
  const cpuCount = sandboxResourceLimitValue(
    env,
    'OPEN_COWORK_CLOUD_ISOLATION_CPU_LIMIT',
  ) ?? DEFAULT_CLOUD_SANDBOX_RESOURCE_LIMITS.cpuCount
  const pids = sandboxResourceLimitValue(
    env,
    'OPEN_COWORK_CLOUD_ISOLATION_PIDS_LIMIT',
  ) ?? DEFAULT_CLOUD_SANDBOX_RESOURCE_LIMITS.pids

  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) {
    throw new CloudExecutionIsolationError(
      'isolation_memory_limit_invalid',
      'OPEN_COWORK_CLOUD_ISOLATION_MEMORY_LIMIT_BYTES must be a positive safe integer.',
    )
  }
  if (!Number.isFinite(cpuCount) || cpuCount <= 0) {
    throw new CloudExecutionIsolationError(
      'isolation_cpu_limit_invalid',
      'OPEN_COWORK_CLOUD_ISOLATION_CPU_LIMIT must be a positive number.',
    )
  }
  if (!Number.isSafeInteger(pids) || pids <= 0) {
    throw new CloudExecutionIsolationError(
      'isolation_pids_limit_invalid',
      'OPEN_COWORK_CLOUD_ISOLATION_PIDS_LIMIT must be a positive safe integer.',
    )
  }

  return { memoryBytes, cpuCount, pids }
}

export type CloudSandboxIsolationProviderOptions = {
  policy: CloudExecutionIsolationPolicy
  workerId: string
  runtimeRootPath: string
  resourceLimits?: CloudSandboxResourceLimits
  observability?: CloudObservabilityAdapter | null
  runtimeAssetPaths?: readonly string[]
  ownerLease?: SandboxWorkerOwnerLease
  runtimeIdentity?: {
    uid: number
    gid: number
  }
  prepareInput?: (
    input: CloudExecutionProvisionInput,
  ) => Promise<CloudExecutionProvisionInput> | CloudExecutionProvisionInput
  runner?: SandboxRuntimeCommandRunner
  startupTimeoutMs?: number
  orphanCleanupRetryMs?: number
  cleanupPrivateRuntimePaths?: (input: CloudExecutionProvisionInput) => void
  controlBridgeFactory?: (input: {
    boundaryId: string
    containerPort: number
  }) => Promise<CloudIsolationControlBridge>
}

export class CloudExecutionIsolationError extends Error {
  readonly code = CLOUD_EXECUTION_ISOLATION_ERROR_CODE
  readonly reasonCode: string

  constructor(reasonCode: string, message = 'Cloud execution isolation is unavailable.') {
    super(message)
    this.name = 'CloudExecutionIsolationError'
    this.reasonCode = reasonCode
  }
}

/**
 * A provider throws this only when provisioning failed after allocating an
 * execution boundary and that boundary could not yet be removed. The cleanup
 * promise resolves after the provider proves the allocation is gone. Capacity
 * controllers must retain the failed attempt's permit until then.
 */
export class CloudExecutionCleanupDebtError extends CloudExecutionIsolationError {
  readonly cleanup: Promise<void>

  constructor(reasonCode: string, cleanup: Promise<void>) {
    super(reasonCode, 'Cloud execution boundary cleanup is pending.')
    this.name = 'CloudExecutionCleanupDebtError'
    this.cleanup = cleanup
  }
}

function envValue(env: Env, key: string) {
  const value = env[key]?.trim()
  return value || null
}

function parseMode(value: string | null): CloudExecutionIsolationMode {
  // Shared-process execution is never an implicit fallback. Local development
  // must opt into it by name; an omitted mode defaults to the fail-closed
  // sandbox boundary in every execution role.
  if (!value) return 'sandbox'
  if (
    value === 'sandbox'
    || value === 'development-process'
    || value === 'external-provider'
  ) return value
  throw new CloudExecutionIsolationError(
    'isolation_mode_invalid',
    `Invalid OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE "${value}".`,
  )
}

function parseEngine(value: string | null): SandboxEngine {
  if (!value || value === 'docker') return 'docker'
  if (value === 'apple-container') return value
  throw new CloudExecutionIsolationError(
    'isolation_engine_invalid',
    `Invalid OPEN_COWORK_CLOUD_ISOLATION_ENGINE "${value}".`,
  )
}

function parseNetwork(env: Env): CloudExecutionNetworkPolicy {
  const mode = envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY') || 'deny-all'
  if (mode === 'deny-all') return { kind: 'deny-all' }
  if (mode !== 'restricted') {
    throw new CloudExecutionIsolationError(
      'isolation_network_policy_invalid',
      `Invalid OPEN_COWORK_CLOUD_ISOLATION_NETWORK_POLICY "${mode}".`,
    )
  }
  return {
    kind: 'restricted',
    networkName: envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_NETWORK_NAME') || '',
    policyId: envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_EGRESS_POLICY_ID') || '',
  }
}

function imageSource(engine: SandboxEngine, image: string) {
  return engine === 'docker' ? `docker://${image}` : `oci://${image}`
}

function normalizedSha256(value: string | null) {
  if (!value) return null
  const normalized = value.toLowerCase().startsWith('sha256:')
    ? value.toLowerCase()
    : `sha256:${value.toLowerCase()}`
  return /^sha256:[a-f0-9]{64}$/.test(normalized) ? normalized : null
}

function digestPinnedImage(image: string, digest: string) {
  // A locally built image may have an immutable image ID but no RepoDigests.
  // Docker accepts that sha256:<id> directly, so preserve it instead of
  // mis-parsing "sha256" as a repository with the digest as a tag.
  if (image.toLowerCase() === digest.toLowerCase()) return digest
  const withoutDigest = image.split('@')[0]!
  const lastSlash = withoutDigest.lastIndexOf('/')
  const lastColon = withoutDigest.lastIndexOf(':')
  const repository = lastColon > lastSlash
    ? withoutDigest.slice(0, lastColon)
    : withoutDigest
  return `${repository}@${digest}`
}

function validContainerCommand(value: string) {
  if (!value.startsWith('/') || value.includes('\0') || value.includes('\n')) return false
  return !value.split('/').some((segment) => segment === '..')
}

export function cloudRoleRunsExecution(role: CloudRuntimePolicy['role']) {
  return role === 'worker' || role === 'all-in-one'
}

export function resolveCloudExecutionIsolationPolicy(input: {
  deploymentTier: CloudDeploymentTier
  role: CloudRuntimePolicy['role']
  env?: Env
}): CloudExecutionIsolationPolicy {
  const env = input.env || process.env
  const applies = cloudRoleRunsExecution(input.role)
  const required = applies && input.deploymentTier !== 'local'
  const mode = applies
    ? parseMode(envValue(env, 'OPEN_COWORK_CLOUD_EXECUTION_ISOLATION_MODE'))
    : 'development-process'
  const blockers: string[] = []
  const network = applies ? parseNetwork(env) : { kind: 'deny-all' as const }
  let engine: SandboxEngine | null = null
  let opencodeCommand: string | null = null
  let imageComponentId: string | null = null
  let componentManifest: SandboxComponentManifest | null = null

  if (applies && mode === 'development-process' && required) {
    blockers.push('development_process_forbidden')
  }

  if (applies && mode === 'sandbox') {
    engine = parseEngine(envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_ENGINE'))
    if (engine !== 'docker') blockers.push('sandbox_engine_not_supported_for_cloud_runtime')
    opencodeCommand = envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_OPENCODE_BIN')
      || '/app/node_modules/.bin/opencode'
    if (!validContainerCommand(opencodeCommand)) {
      blockers.push('sandbox_opencode_command_invalid')
    }
    const image = envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_IMAGE')
    const declaredSha256 = envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_IMAGE_SHA256')
    const sha256 = normalizedSha256(declaredSha256)
    const signature = envValue(env, 'OPEN_COWORK_CLOUD_ISOLATION_IMAGE_SIGNATURE')
    imageComponentId = 'cloud-opencode-runtime'
    if (!image) blockers.push('sandbox_image_missing')
    if (!declaredSha256) blockers.push('sandbox_image_digest_missing')
    else if (!sha256) blockers.push('sandbox_image_digest_invalid')
    if (image?.includes('@sha256:') && sha256 && !image.endsWith(`@${sha256}`)) {
      blockers.push('sandbox_image_digest_mismatch')
    }
    componentManifest = image
      ? {
        format: 'open-cowork-sandbox-component-manifest-v1',
        components: [{
          id: imageComponentId,
          kind: 'image',
          source: imageSource(engine, sha256 ? digestPinnedImage(image, sha256) : image),
          ...(sha256 ? { sha256 } : {}),
          ...(signature ? { signature } : {}),
          verified: Boolean(sha256 || signature),
        }],
      }
      : null
  }

  if (applies && mode !== 'development-process' && network.kind === 'restricted') {
    if (!network.networkName) blockers.push('sandbox_network_name_missing')
    if (!network.policyId) blockers.push('sandbox_egress_policy_id_missing')
  }

  return {
    required,
    mode,
    deploymentTier: input.deploymentTier,
    engine,
    opencodeCommand,
    imageComponentId,
    componentManifest,
    network,
    blockers,
    warning: applies && mode === 'development-process'
      ? 'Cloud execution is using the development-only shared host process boundary.'
      : null,
  }
}

export function developmentProcessIsolationCapability(): CloudExecutionIsolationCapability {
  return {
    provider: 'development-process',
    available: true,
    verified: false,
    engine: 'host-process',
    processIsolation: 'shared-host',
    userIsolation: 'shared-worker',
    mountScope: 'unverified',
    runtimeHomeScope: 'execution',
    descendantCleanup: 'best-effort',
    networkPolicy: 'unverified',
    reasonCode: 'development_process_only',
  }
}

export function createDevelopmentProcessIsolationProvider(
  runtimeFactory: (input: CloudExecutionProvisionInput) => Promise<CloudRuntimeAdapter> | CloudRuntimeAdapter,
): CloudExecutionIsolationProvider {
  const retryCleanup = (adapter: CloudRuntimeAdapter) => new Promise<void>((resolve) => {
    const attempt = async () => {
      try {
        await adapter.close?.()
        resolve()
      } catch {
        const timer = setTimeout(() => void attempt(), 100)
        timer.unref?.()
      }
    }
    const timer = setTimeout(() => void attempt(), 100)
    timer.unref?.()
  })
  const throwIfAborted = (input: CloudExecutionProvisionInput) => {
    if (!input.signal?.aborted) return
    throw input.signal.reason instanceof Error
      ? input.signal.reason
      : new DOMException('Runtime provisioning was aborted.', 'AbortError')
  }
  return {
    name: 'development-process',
    async capability() {
      return developmentProcessIsolationCapability()
    },
    async provision(input) {
      throwIfAborted(input)
      const adapter = await runtimeFactory(input)
      if (input.signal?.aborted) {
        try {
          await adapter.close?.()
        } catch {
          throw new CloudExecutionCleanupDebtError(
            'development_runtime_cleanup_pending',
            retryCleanup(adapter),
          )
        }
        throwIfAborted(input)
      }
      const capability = developmentProcessIsolationCapability()
      const attestation: CloudExecutionIsolationAttestation = {
        ...capability,
        format: CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT,
        boundaryId: 'development-shared-host',
        establishedAt: new Date().toISOString(),
      }
      let closed = false
      return {
        adapter,
        attestation,
        async close() {
          if (closed) return
          await adapter.close?.()
          closed = true
        },
      }
    },
  }
}

export function evaluateCloudExecutionIsolationCapability(
  policy: CloudExecutionIsolationPolicy,
  capability: CloudExecutionIsolationCapability,
) {
  const blockers = [...policy.blockers]
  if (!capability.available) blockers.push(capability.reasonCode || 'provider_unavailable')
  if (policy.required) {
    if (!capability.verified) blockers.push('capability_unverified')
    if (capability.processIsolation === 'shared-host') blockers.push('process_isolation_missing')
    if (capability.userIsolation === 'shared-worker') blockers.push('user_isolation_missing')
    if (capability.mountScope !== 'execution') blockers.push('mount_scope_unverified')
    if (capability.runtimeHomeScope !== 'execution') blockers.push('runtime_home_scope_unverified')
    if (capability.descendantCleanup === 'best-effort') blockers.push('descendant_cleanup_unverified')
    if (capability.networkPolicy !== policy.network.kind) blockers.push('network_policy_mismatch')
  }
  return {
    ok: blockers.length === 0,
    blockers: Array.from(new Set(blockers)),
  }
}

export function assertCloudExecutionIsolationCapability(
  policy: CloudExecutionIsolationPolicy,
  capability: CloudExecutionIsolationCapability,
) {
  const verdict = evaluateCloudExecutionIsolationCapability(policy, capability)
  if (verdict.ok) return
  throw new CloudExecutionIsolationError(
    verdict.blockers[0] || 'isolation_capability_unavailable',
  )
}

export function assertCloudExecutionIsolationAttestation(
  policy: CloudExecutionIsolationPolicy,
  attestation: CloudExecutionIsolationAttestation,
) {
  if (attestation.format !== CLOUD_EXECUTION_ISOLATION_ATTESTATION_FORMAT || !attestation.boundaryId) {
    throw new CloudExecutionIsolationError('isolation_attestation_invalid')
  }
  assertCloudExecutionIsolationCapability(policy, attestation)
}
