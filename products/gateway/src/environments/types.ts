/** Environment domain types (extracted for LOC budget; audit 2026-07-21). */

export type EnvironmentBackend = 'local-process' | 'local-container' | 'remote-crabbox' | 'custom'
export type EnvironmentSelector = string | EnvironmentSpecInput

export interface GatewayEnvironmentConfig {
  defaultEnvironment: string
  maxConcurrent: number
  maxRetained: number
  backendMaxConcurrent: Partial<Record<EnvironmentBackend, number>>
  requireApprovalForRemote: boolean
  requireApprovalForPrivilegedContainer: boolean
  environments: Record<string, EnvironmentSpecInput>
}

export interface EnvironmentSpecInput {
  name?: string
  extends?: string
  environment?: string
  backend?: EnvironmentBackend | string
  workdir?: string
  tools?: string[]
  setup?: string[]
  validation?: string[]
  env?: Record<string, string>
  resources?: EnvironmentResources
  network?: EnvironmentNetwork
  secrets?: EnvironmentSecretPolicy
  cache?: EnvironmentCachePolicy
  cleanup?: EnvironmentCleanupPolicy
  container?: LocalContainerSpec
  crabbox?: CrabboxSpec
  custom?: Record<string, unknown>
  [key: string]: unknown
}

export interface EnvironmentResources {
  cpu?: number
  memory?: string
  memoryGb?: number
  disk?: string
  diskGb?: number
  timeout?: string
  timeoutMs?: number
  maxConcurrent?: number
}

export interface EnvironmentNetwork {
  mode?: 'unrestricted' | 'restricted' | 'disabled'
  allow?: string[]
}

export interface EnvironmentSecretPolicy {
  allow?: string[]
}

export interface EnvironmentCachePolicy {
  volumes?: Array<{ name: string; path: string; mode?: 'readwrite' | 'readonly' }>
}

export interface EnvironmentCleanupPolicy {
  ttl?: string
  ttlMs?: number
  retainOnFailure?: boolean
  retainOnSuccess?: boolean
}

export interface LocalContainerSpec {
  runtime?: string
  image?: string
  entrypoint?: string[]
  workdir?: string
  user?: string
  network?: string
  privileged?: boolean
  mounts?: Array<{ source: string; target: string; readonly?: boolean }>
  pull?: 'never' | 'missing' | 'always'
  warm?: boolean
  [key: string]: unknown
}

export interface CrabboxSpec {
  cli?: string
  brokerUrl?: string
  profile?: string
  provider?: string
  class?: string
  ttl?: string
  warm?: boolean
  keepOnFailure?: boolean
  actionsHydration?: boolean
  [key: string]: unknown
}

export interface EnvironmentSpec {
  name: string
  backend: EnvironmentBackend
  workdir?: string
  tools: string[]
  setup: string[]
  validation: string[]
  env: Record<string, string>
  resources: Required<Pick<EnvironmentResources, 'timeoutMs'>> & EnvironmentResources
  network: Required<Pick<EnvironmentNetwork, 'mode'>> & EnvironmentNetwork
  secrets: Required<Pick<EnvironmentSecretPolicy, 'allow'>>
  cache: Required<Pick<EnvironmentCachePolicy, 'volumes'>>
  cleanup: Required<Pick<EnvironmentCleanupPolicy, 'ttlMs' | 'retainOnFailure' | 'retainOnSuccess'>>
  container?: LocalContainerSpec
  crabbox?: CrabboxSpec
  custom?: Record<string, unknown>
  source: string[]
  specHash: string
}

export interface EnvironmentPreflightResult {
  ok: boolean
  checked: string[]
  missing: string[]
  warnings: string[]
  commandRefs: string[]
}

export interface EnvironmentRunRecord {
  id: string
  name: string
  backend: EnvironmentBackend
  status: 'prepared' | 'blocked' | 'retained' | 'released' | 'cleanup_failed'
  specHash: string
  workdir?: string
  runtime?: string
  image?: string
  provider?: string
  class?: string
  leaseId?: string
  runId?: string
  startedAt: string
  updatedAt: string
  ttlMs: number
  cleanup: Required<Pick<EnvironmentCleanupPolicy, 'retainOnFailure' | 'retainOnSuccess'>> & { state: 'pending' | 'released' | 'retained' | 'failed' }
  resources: EnvironmentResources
  network: Required<Pick<EnvironmentNetwork, 'mode'>> & EnvironmentNetwork
  secrets: { allowedNames: string[] }
  preflight: EnvironmentPreflightResult
  artifacts: string[]
  metadata: Record<string, unknown>
}

export interface EnvironmentHydrationInput {
  taskId: string
  roadmapId?: string
  stage: string
  workdir?: string
  dependencyTaskIds?: string[]
  sourcePlan?: EnvironmentSourcePlan
}

export interface EnvironmentSourcePlan {
  required: boolean
  baseRef: string
  workdir?: string
  dependencyTaskIds: string[]
  patches: EnvironmentSourcePatch[]
  missing: Array<{ taskId: string; reason: string }>
}

export interface EnvironmentSourcePatch {
  id: string
  taskId: string
  runId: string
  stage: string
  ref: string
  path?: string
  content: string
  changedFiles: string[]
}

export interface EnvironmentSourceHydrationSummary {
  baseRef?: string
  dependencyTaskIds: string[]
  patchIds: string[]
  changedFiles: string[]
  applyResult: 'not_required' | 'applied' | 'failed'
  missing?: Array<{ taskId: string; reason: string }>
}

export interface EnvironmentHydrationResult {
  ok: boolean
  status: 'not_required' | 'applied' | 'failed'
  evidence: string[]
  reason?: string
  artifacts?: string[]
  source?: EnvironmentSourceHydrationSummary
}

export interface EnvironmentAttachmentResult {
  ok: boolean
  workdir?: string
  commandPrefix: string[]
  evidence: string[]
  reason?: string
}

export interface EnvironmentArtifactCollectionResult {
  ok: boolean
  artifacts: string[]
  evidence: string[]
  reason?: string
}

export interface EnvironmentReconciliationResult {
  ok: boolean
  checked: number
  active: number
  retained: number
  cleanupFailed: number
  evidence: string[]
}

export interface EnvironmentPrepareOptions {
  taskId: string
  stage: string
  now?: Date
  dispatchId?: string
  idempotencyKey?: string
}

export interface EnvironmentAcquisitionLookupResult {
  ok: boolean
  found: boolean
  backend: EnvironmentBackend
  idempotencyKeyHash: string
  resourceId?: string
  provider?: string
  state?: string
  metadata: Record<string, unknown>
  evidence: string[]
  reason?: string
}

export interface EnvironmentAcquisitionReleaseResult {
  ok: boolean
  found: boolean
  released: boolean
  backend: EnvironmentBackend
  idempotencyKeyHash: string
  resourceId?: string
  evidence: string[]
  reason?: string
}

export interface EnvironmentController {
  backend: EnvironmentBackend | 'metadata'
  resolve(input: EnvironmentResolutionInput): EnvironmentResolution
  prepare(spec: EnvironmentSpec, options: EnvironmentPrepareOptions): EnvironmentRunRecord
  preflight(spec: EnvironmentSpec): EnvironmentPreflightResult
  hydrate(spec: EnvironmentSpec, input: EnvironmentHydrationInput): EnvironmentHydrationResult
  attach(spec: EnvironmentSpec, environment: EnvironmentRunRecord): EnvironmentAttachmentResult
  collectArtifacts(environment: EnvironmentRunRecord): EnvironmentArtifactCollectionResult
  release(environment: EnvironmentRunRecord): EnvironmentRunRecord
  retain(environment: EnvironmentRunRecord): EnvironmentRunRecord
  cleanup(environment: EnvironmentRunRecord): EnvironmentRunRecord
  reconcile(environments: EnvironmentRunRecord[]): EnvironmentReconciliationResult
  lookupByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionLookupResult
  releaseByKey(spec: EnvironmentSpec, idempotencyKey: string): EnvironmentAcquisitionReleaseResult
}

export type EnvironmentResolution =
  | { ok: true; spec: EnvironmentSpec; repoConfigPath?: string }
  | { ok: false; reason: string; source: string[] }

export interface EnvironmentResolutionInput {
  taskEnvironment?: EnvironmentSelector
  roadmapEnvironment?: EnvironmentSelector
  profileEnvironment?: EnvironmentSelector
  config: GatewayEnvironmentConfig
  stage: string
  workdir?: string
  requiredTools?: string[]
}

