export interface PerfCounterSnapshot {
  kind: 'counter'
  name: string
  value: number
  updatedAt: string
}

export interface PerfDistributionSnapshot {
  kind: 'distribution'
  name: string
  unit: 'ms' | 'count'
  count: number
  samplesTracked: number
  total: number
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  last: number
  slowCount: number
  updatedAt: string
}

export interface PerfSnapshot {
  capturedAt: string
  counters: PerfCounterSnapshot[]
  distributions: PerfDistributionSnapshot[]
}

export type RuntimeReadinessPhase =
  | 'environment'
  | 'config-build'
  | 'credential-redaction'
  | 'sidecar-resolution'
  | 'process-launch'
  | 'storage-migration'
  | 'health-auth'
  | 'event-stream'
  | 'mcp-skill-bridge'
  | 'workflow-service'
  | 'cloud-gateway-connector'
  | 'ready'
  | 'error'

export type RuntimeReadinessStatus = 'started' | 'passed' | 'failed' | 'skipped'

export interface RuntimeReadinessTimelineEntry {
  phase: RuntimeReadinessPhase
  status: RuntimeReadinessStatus
  message: string
  code: string
  timestamp: string
}

export type RuntimeDoctorSeverity = 'info' | 'warning' | 'error'
export type RuntimeDoctorStatus = 'pending' | 'pass' | 'fail' | 'skipped'

export interface RuntimeDoctorCheck {
  code: string
  severity: RuntimeDoctorSeverity
  status: RuntimeDoctorStatus
  message: string
  remediation?: string
  evidence?: Record<string, string | number | boolean | null>
  updatedAt: string
}

export const RUNTIME_COMPONENT_MANIFEST_FORMAT = 'open-cowork-runtime-component-manifest-v1' as const

export type RuntimeComponentKind =
  | 'opencode-cli'
  | 'opencode-sdk'
  | 'helper-sidecar'
  | 'sandbox-image'
  | 'gateway-helper'
  | 'worker-image'
  | 'semantic-ui-mcp'
  | 'workflow-mcp'
  | 'agent-tool-mcp'

export type RuntimeComponentSourcePolicy = 'bundled' | 'managed' | 'external' | 'development'
export type RuntimeComponentCompatibilityStatus = 'supported' | 'experimental' | 'blocked' | 'unknown'

export interface RuntimeComponentManifestEntry {
  id: string
  kind: RuntimeComponentKind
  version: string
  observedVersion?: string
  upstreamVersion?: string
  platform?: string
  arch?: string
  path?: string
  url?: string
  sha256?: string
  observedSha256?: string
  signature?: string
  sourcePolicy: RuntimeComponentSourcePolicy
  compatibilityStatus: RuntimeComponentCompatibilityStatus
  requiredCapabilities?: string[]
}

export interface RuntimeComponentManifest {
  format: typeof RUNTIME_COMPONENT_MANIFEST_FORMAT
  generatedAt: string
  components: RuntimeComponentManifestEntry[]
}

export interface RuntimeComponentVerificationIssue {
  code:
    | 'component_manifest_missing'
    | 'component_manifest_parse_failed'
    | 'component_manifest_format_invalid'
    | 'component_duplicate'
    | 'component_identity_invalid'
    | 'component_source_missing'
    | 'component_version_mismatch'
    | 'component_sha256_invalid'
    | 'component_observed_sha256_invalid'
    | 'component_hash_mismatch'
    | 'component_provenance_missing'
    | 'component_compatibility_blocked'
    | 'component_compatibility_unknown'
  severity: RuntimeDoctorSeverity
  componentId?: string
  message: string
}

export interface RuntimeComponentVerificationReport {
  format: typeof RUNTIME_COMPONENT_MANIFEST_FORMAT
  ok: boolean
  generatedAt: string | null
  checkedAt: string
  developmentOverride: boolean
  components: RuntimeComponentManifestEntry[]
  issues: RuntimeComponentVerificationIssue[]
  redacted: true
}

export type RuntimeCapabilityKind =
  | 'provider'
  | 'model'
  | 'mcp'
  | 'skill'
  | 'agent'
  | 'tool'
  | 'workflow'
  | 'opencode-plugin'

export type RuntimeCapabilityStatus =
  | 'active'
  | 'available'
  | 'disabled'
  | 'blocked'
  | 'missing'
  | 'auth-pending'
  | 'runtime-failure'
  | 'unsupported'
  | 'ask-gated'
  | 'unknown'

export interface RuntimeCapabilityProvenanceRecord {
  id: string
  kind: RuntimeCapabilityKind
  status: RuntimeCapabilityStatus
  reasonCode: string
  source: string
  productMode: string
  evidence?: Record<string, string | number | boolean | string[] | null>
  redacted: true
}

export interface RuntimeCapabilityConflictRecord {
  id: string
  kind: RuntimeCapabilityKind
  winnerSource: string
  loserSources: string[]
  reasonCode: string
  redacted: true
}

export type RuntimeCompatibilityCategory =
  | 'sdk-import'
  | 'config'
  | 'event'
  | 'permission'
  | 'plugin'
  | 'route'
  | 'runtime-binary'

export type RuntimeCompatibilityStatus = 'supported' | 'shim' | 'private-assumption' | 'blocked' | 'unknown'

export interface RuntimeCompatibilityAssumption {
  id: string
  category: RuntimeCompatibilityCategory
  status: RuntimeCompatibilityStatus
  owner: string
  sourceVersion: string
  reason: string
  tests: string[]
  removalCondition?: string
  productModes?: string[]
}

export interface RuntimeCompatibilityReport {
  opencodeVersion: string | null
  assumptions: RuntimeCompatibilityAssumption[]
}

export interface RuntimeStatus {
  ready: boolean
  error?: string | null
  phase?: RuntimeReadinessPhase
  updatedAt?: string
  timeline?: RuntimeReadinessTimelineEntry[]
  checks?: RuntimeDoctorCheck[]
  components?: RuntimeComponentVerificationReport | null
}

export type RuntimeLoadingPhase =
  | 'idle'
  | 'starting'
  | 'config'
  | 'managed-server'
  | 'connecting-events'
  | 'mcp'
  | 'ready'
  | 'error'

export interface RuntimeLoadingStatus {
  phase: RuntimeLoadingPhase
  message: string
  ready: boolean
  error: string | null
  updatedAt: string
}

export interface RuntimeInputDiagnostics {
  opencodeVersion: string | null
  providerId: string | null
  providerName: string | null
  providerPackage: string | null
  modelId: string | null
  runtimeModel: string | null
  defaultProviderId: string | null
  defaultModelId: string | null
  providerSource: 'settings' | 'default' | 'fallback'
  modelSource: 'settings' | 'default' | 'fallback'
  providerOptions: Record<string, unknown>
  credentialOverrideKeys: string[]
  capabilities?: RuntimeCapabilityProvenanceRecord[]
  conflicts?: RuntimeCapabilityConflictRecord[]
  compatibility?: RuntimeCompatibilityReport
}

export interface RecentProject {
  index: number
  directory: string
  latestSessionId: string
  latestTitle: string | null
  updatedAt: string
}

export interface ToolListOptions {
  workspaceId?: string
  sessionId?: string
  directory?: string | null
  provider?: string | null
  model?: string | null
  // When true, probe each MCP to enumerate its method list. Default
  // false — the grid view only needs name/description per tool, and
  // probing 16 MCPs sequentially costs multi-seconds on Capabilities
  // page load. The tool-detail endpoint (`capabilities.tool(id)`)
  // passes true to populate the method table when a user actually
  // opens one tool.
  deep?: boolean
}

export interface RuntimeToolDescriptor {
  id?: string
  name?: string
  description?: string
}

export interface RuntimeContextOptions {
  workspaceId?: string
  sessionId?: string
  directory?: string | null
}
