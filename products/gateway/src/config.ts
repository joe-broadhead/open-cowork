import * as fs from 'node:fs'
import { z } from 'zod'
import { stableStringify } from './stable-stringify.js'
import * as path from 'node:path'
import * as os from 'node:os'
import * as net from 'node:net'
import { createHash } from 'node:crypto'
import { normalizeEnvironmentSelector, normalizeGatewayEnvironmentConfig, type EnvironmentSelector, type GatewayEnvironmentConfig } from './environments.js'
import { ConfigError } from './errors.js'
import { gatewayEnv, type EnvSource } from './env.js'
import { setTrustedOpenCodePeerHosts } from './opencode-peer-hosts.js'

const zStringRecord = <Schema extends z.ZodTypeAny>(schema: Schema) => z.record(z.string(), schema)

export type AgentPromotionState = 'draft' | 'evaluated' | 'promoted' | 'deprecated' | 'blocked'

export interface AgentBudgetContract {
  maxTokens?: number
  maxCostUsd?: number
  maxRuntimeMs?: number
  retryLimit?: number
  humanGate?: 'never' | 'on-risk' | 'always'
}

export interface AgentOutputContract {
  format?: 'text' | 'json' | 'stage-result' | 'supervisor-result'
  schema?: Record<string, unknown>
  requiredEvidence?: string[]
  requiredDecisions?: string[]
  artifactRefs?: boolean
  failureClass?: boolean
}

export interface AgentProfile {
  version?: string
  updatedAt?: string
  description?: string
  model: { providerID: string; modelID: string; variant?: string }
  agent: string
  skills: string[]
  mcpServers?: string[]
  tools?: string[]
  permission: Record<string, string>
  heartbeatMs: number
  maxTokens: number
  role: 'planning' | 'execution'
  environment?: EnvironmentSelector
  capabilities?: string[]
  budget?: AgentBudgetContract
  outputContract?: AgentOutputContract
  promotionState?: AgentPromotionState
}

export interface ReviewGateIsolationConfig {
  enabled: boolean
  stages: string[]
  deniedTools: string[]
  allowBashEvidenceCommands: boolean
  bashAllowlist: string[]
  forbiddenPathHints: string[]
}

export interface AgentTeamConfig {
  description?: string
  version?: string
  updatedAt?: string
  promotionState?: AgentPromotionState
  roles: Record<string, string>
  capabilityRequirements: Record<string, string[]>
  qualitySpecDefaults: Record<string, unknown>
  revision: string
}

export interface ChannelAllowlistRule {
  chatId: string
  threadId?: string
  userIds?: string[]
  adminUserIds?: string[]
}

export interface ExposedHttpSecurityConfig {
  /**
   * Reject daemon startup in exposed mode (allowNonLocalHttp) when a configured
   * Gateway HTTP token is shorter than minTokenLength or carries less than
   * minTokenEntropyBits of estimated entropy. Only affects exposed mode with a
   * token; localhost default and public-webhook/unsafe modes are unaffected.
   */
  requireStrongToken: boolean
  minTokenLength: number
  minTokenEntropyBits: number
  /**
   * Immediate reverse-proxy peers whose Forwarded/X-Forwarded-For chain may be
   * trusted when deriving the client address used by abuse controls. Forwarded
   * headers from every other peer are ignored.
   */
  trustedProxyCidrs: string[]
  /**
   * Sliding-window per-remote-address request limiter, active only in exposed
   * mode. Bounds memory by capping distinct tracked clients (LRU eviction).
   */
  rateLimit: {
    enabled: boolean
    windowMs: number
    maxRequests: number
    maxTrackedClients: number
  }
  /**
   * Consecutive-auth-failure lockout, active only in exposed mode. After
   * maxConsecutiveFailures denied requests from one address the address is
   * temporarily rejected with a Retry-After backoff; a successful auth resets it.
   */
  authLockout: {
    enabled: boolean
    maxConsecutiveFailures: number
    lockoutMs: number
  }
}

export interface SecurityConfig {
  httpHost: string
  allowNonLocalHttp: boolean
  publicWebhookMode: boolean
  unsafeAllowNoAuth: boolean
  /**
   * Default true. Loopback write/admin requests must present a capability-scoped
   * bearer token while local read/webhook routes stay ergonomic. Additive/optional
   * so existing literal SecurityConfig constructions keep compiling;
   * normalizeConfig() always populates it, so getConfig() never omits it.
   */
  capabilityScopedLoopback?: boolean
  /**
   * Default true. Destructive human-gate approvals arriving through the MCP proxy
   * trust tier are rejected, so an agent holding the MCP surface cannot
   * self-approve its own destructive gates; the operator must approve out-of-band.
   */
  requireNonMcpDestructiveApproval?: boolean
  exposedHttp?: ExposedHttpSecurityConfig
  /**
   * When true, any member of a trusted channel target may send free text to the
   * bound agent session (pre-strict behavior). Default false: free text requires a
   * trusted actor (allowlisted userIds/adminUserIds or a private chat where the
   * sender id equals the chat id). Privileged commands always actor-check.
   */
  trustTargetMembersForFreeText: boolean
  unsafeAllowAllChannelTargets: {
    telegram: boolean
    whatsapp: boolean
    discord: boolean
  }
  channelAllowlists: {
    telegram: ChannelAllowlistRule[]
    whatsapp: ChannelAllowlistRule[]
    discord: ChannelAllowlistRule[]
  }
}

export type GovernanceAction = 'block' | 'pause' | 'warn'

export interface GovernanceBudgetConfig {
  dailyCostUsd?: number
  weeklyCostUsd?: number
  monthlyCostUsd?: number
  totalCostUsd?: number
  tokenLimit?: number
  action?: GovernanceAction
}

export interface GovernanceConfig {
  enabled: boolean
  action: GovernanceAction
  global: GovernanceBudgetConfig
  roadmaps: Record<string, GovernanceBudgetConfig>
  tasks: Record<string, GovernanceBudgetConfig>
  stages: Record<string, GovernanceBudgetConfig>
  runtime: {
    maxRunMs: number
    staleRunMs: number
  }
}

export type HumanGateTimeoutAction = 'remind' | 'escalate' | 'pause' | 'block'

export interface HumanLoopConfig {
  enabled: boolean
  taskStartApproval: boolean
  stageApprovals: string[]
  externalSideEffectApproval: boolean
  budgetExceptionApproval: boolean
  destructiveActionApproval: boolean
  credentialUseApproval: boolean
  defaultTimeoutMs: number
  timeoutAction: HumanGateTimeoutAction
  priorityTimeoutMs: Record<'HIGH' | 'MEDIUM' | 'LOW', number>
}

/**
 * Proactive profile-health alert (#205). Fires when a scheduler profile's
 * GENUINE failure rate over the window exceeds `maxGenuineFailureRate` — using
 * the #202 error-class split, so Gateway session-recovery churn and
 * provider-balance blips (operational/external cohorts) never trip it. Requires
 * at least `minRuns` terminal runs so a thin sample cannot cry wolf.
 */
export interface ProfileHealthAlertConfig {
  enabled: boolean
  windowDays: number
  minRuns: number
  maxGenuineFailureRate: number
}

/**
 * Stuck-task alert (#203). Fires when a single task has accumulated an excessive
 * cumulative run count — the runaway signal that let one dogfood Issue silently
 * balloon to 81 runs. `runThreshold` is the warn line; it should sit below
 * `scheduler.maxRunsPerTask` so the operator is warned BEFORE the per-task run
 * cap hard-blocks the task. Reads a bounded indexed aggregate, never mutates.
 */
export interface StuckTaskAlertConfig {
  enabled: boolean
  runThreshold: number
}

export interface AlertsConfig {
  profileHealth: ProfileHealthAlertConfig
  stuckTask: StuckTaskAlertConfig
  delivery: {
    enabled: boolean
    maxAttempts: number
    targets: Array<{
      provider: 'telegram' | 'whatsapp' | 'discord'
      chatId: string
      threadId?: string
      minimumSeverity: 'warning' | 'critical'
    }>
  }
}

export type StorageBackendMode = 'local_sqlite'

export interface StorageConfig {
  backend: StorageBackendMode
  /**
   * Durable-store retention windows for the unbounded history tables. The
   * scheduler and dashboards read a bounded recent window (default analytics
   * window is 30 days, monthly governance ≈ 31 days), so these defaults keep
   * every real consumer's data while bounding truly-old history. `runsMaxAgeDays`
   * has a 60-day floor so retention can never prune inside a doubled analytics
   * window, and the most-recent run per task plus any active/current run are
   * always preserved regardless of age.
   */
  retention: {
    runsMaxAgeDays: number
    receiptsMaxAgeDays: number
  }
}

export interface SecretLifecycleConfig {
  rotationHealthByInputId?: Record<string, string>
  rotationHealthByReferenceId?: Record<string, string>
  lastVerifiedAtByInputId?: Record<string, string>
  lastVerifiedAtByReferenceId?: Record<string, string>
  revokedInputIds?: string[]
  revokedReferenceIds?: string[]
  revokedAtByInputId?: Record<string, string>
  revokedAtByReferenceId?: Record<string, string>
}

export interface GatewayConfig {
  opencodeConfigDir?: string
  opencodeUrl: string
  /** Trusted remote/local-network OpenCode serve peers (Phase 3). Default empty = local-only. */
  opencodePeers?: Record<string, {
    baseUrl: string
    default?: boolean
    allowHostnames?: string[]
    basicAuth?: { usernameEnv?: string; passwordEnv?: string; passwordFile?: string }
    requireHttps?: boolean
  }>
  httpPort: number
  heartbeat: {
    intervalMs: number
  }
  channelSync: {
    enabled: boolean
    intervalMs: number
    includeUserMessages: boolean
    providerBackoffMs?: number
    maxDeliveryAttempts?: number
  }
  security: SecurityConfig
  governance: GovernanceConfig
  humanLoop: HumanLoopConfig
  alerts: AlertsConfig
  storage: StorageConfig
  secretLifecycle?: SecretLifecycleConfig
  environments: GatewayEnvironmentConfig
  scheduler: {
    enabled: boolean
    intervalMs: number
    maxConcurrent: number
    leaseMs: number
    retryLimit: number
    // Cumulative ceiling on how many RUNS one task may ever accumulate — one run
    // per stage dispatch, NOT per pipeline pass or retry attempt. A 3-stage
    // pipeline uses ~3 runs per clean pass and every retry/session-recovery
    // re-dispatch adds another, so a long custom pipeline should raise this
    // deliberately. Reaching it hard-blocks the task for operator attention.
    maxRunsPerTask: number
    defaultPipeline: string[]
    stageProfiles: Record<string, string>
    stageConcurrency: Record<string, number>
    profileConcurrency: Record<string, number>
    capacity?: {
      teamConcurrency: Record<string, number>
      roadmapConcurrency: Record<string, number>
      channelConcurrency: Record<string, number>
    }
    reviewGateIsolation: ReviewGateIsolationConfig
  }
  profiles: Record<string, AgentProfile>
  agentTeams: Record<string, AgentTeamConfig>
  agentFactory: {
    blueprintDirs: string[]
  }
  channels: {
    richMessages: { enabled: boolean }
    telegram: { botToken?: string; richMessages?: { enabled: boolean } }
    whatsapp: {
      setupMode?: 'cloudApiDirect'
      accessToken?: string
      phoneNumberId?: string
      verifyToken?: string
      appSecret?: string
    }
    discord: { enabled: boolean; botToken?: string; applicationId?: string; publicKey?: string; richMessages?: { enabled: boolean } }
  }
}

function configDir(): string {
  return gatewayEnv.configDir() || path.join(os.homedir(), '.config', 'opencode-gateway')
}

function configFile(): string {
  return path.join(configDir(), 'config.json')
}

const DEFAULTS: GatewayConfig = {
  opencodeUrl: 'http://127.0.0.1:4096',
  opencodePeers: {},
  httpPort: 4097,
  heartbeat: { intervalMs: 300000 }, // 5min default
  channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true, providerBackoffMs: 60_000, maxDeliveryAttempts: 10 },
  security: {
    httpHost: '127.0.0.1',
    allowNonLocalHttp: false,
    publicWebhookMode: false,
    unsafeAllowNoAuth: false,
    capabilityScopedLoopback: true,
    requireNonMcpDestructiveApproval: true,
    exposedHttp: {
      requireStrongToken: true,
      minTokenLength: 16,
      minTokenEntropyBits: 48,
      trustedProxyCidrs: [],
      rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 120, maxTrackedClients: 4096 },
      authLockout: { enabled: true, maxConsecutiveFailures: 5, lockoutMs: 60_000 },
    },
    trustTargetMembersForFreeText: false,
    unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false },
    channelAllowlists: { telegram: [], whatsapp: [], discord: [] },
  },
  governance: {
    enabled: true,
    action: 'block',
    global: {},
    roadmaps: {},
    tasks: {},
    stages: {},
    runtime: { maxRunMs: 0, staleRunMs: 60 * 60 * 1000 },
  },
  humanLoop: {
    enabled: true,
    taskStartApproval: false,
    stageApprovals: [],
    externalSideEffectApproval: true,
    budgetExceptionApproval: true,
    destructiveActionApproval: true,
    credentialUseApproval: true,
    defaultTimeoutMs: 24 * 60 * 60 * 1000,
    timeoutAction: 'escalate',
    priorityTimeoutMs: { HIGH: 60 * 60 * 1000, MEDIUM: 4 * 60 * 60 * 1000, LOW: 24 * 60 * 60 * 1000 },
  },
  alerts: {
    profileHealth: { enabled: true, windowDays: 7, minRuns: 10, maxGenuineFailureRate: 0.5 },
    stuckTask: { enabled: true, runThreshold: 15 },
    delivery: { enabled: false, maxAttempts: 10, targets: [] },
  },
  storage: {
    backend: 'local_sqlite',
    retention: { runsMaxAgeDays: 90, receiptsMaxAgeDays: 90 },
  },
  environments: normalizeGatewayEnvironmentConfig(),
  scheduler: {
    enabled: true,
    intervalMs: 10000,
    maxConcurrent: 3,
    leaseMs: 60 * 60 * 1000,
    retryLimit: 2,
    maxRunsPerTask: 25,
    defaultPipeline: ['implement', 'review', 'verify'],
    stageProfiles: { default: 'implementer', implement: 'implementer', review: 'reviewer', verify: 'verifier', audit: 'auditor', plan: 'planner' },
    stageConcurrency: {},
    profileConcurrency: {},
    capacity: { teamConcurrency: {}, roadmapConcurrency: {}, channelConcurrency: {} },
    reviewGateIsolation: {
      enabled: true,
      stages: ['review', 'verify', 'audit'],
      deniedTools: ['edit', 'write', 'webfetch', 'websearch', 'browser', 'task', 'todowrite'],
      allowBashEvidenceCommands: true,
      bashAllowlist: [
        'git status',
        'git diff',
        'git log',
        'git show',
        'git branch',
        'git rev-parse',
        'rg',
        'sed',
        'nl',
        'cat',
        'ls',
        'find',
        'wc',
        'npm test',
        'npm run typecheck',
        'npm run build',
        'npm run verify',
        'npm run release:check',
        'uv run --with-requirements docs/requirements.txt mkdocs build --strict',
      ],
      forbiddenPathHints: ['remote GitHub/Linear context', 'network context', 'browser/web tools', 'out-of-repo directories', 'personal notes'],
    },
  },
  profiles: {
    'planner': {
      model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro', variant: 'high' },
      agent: 'gateway-planner',
      skills: ['gateway-planner'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'ask', bash: 'ask' },
      heartbeatMs: 300000,
      maxTokens: 50000,
      role: 'planning',
    },
    'coordinator': {
      model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro', variant: 'high' },
      agent: 'gateway-coordinator',
      skills: ['gateway-coordinator'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'ask', bash: 'allow' },
      heartbeatMs: 0,
      maxTokens: 100000,
      role: 'planning',
    },
    'implementer': {
      model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro', variant: 'high' },
      agent: 'gateway-implementer',
      skills: ['gateway-stage'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'allow', bash: 'allow', todowrite: 'allow' },
      heartbeatMs: 0,
      maxTokens: 200000,
      role: 'execution',
    },
    'reviewer': {
      model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' },
      agent: 'gateway-reviewer',
      skills: ['gateway-stage', 'gateway-review-gate'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'deny', bash: 'allow' },
      heartbeatMs: 0,
      maxTokens: 120000,
      role: 'execution',
    },
    'verifier': {
      model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' },
      agent: 'gateway-verifier',
      skills: ['gateway-stage', 'gateway-review-gate'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'deny', bash: 'allow' },
      heartbeatMs: 0,
      maxTokens: 120000,
      role: 'execution',
    },
    'supervisor': {
      model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' },
      agent: 'gateway-supervisor',
      skills: ['gateway-supervisor'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'deny', bash: 'ask', webfetch: 'ask', websearch: 'ask' },
      heartbeatMs: 0,
      maxTokens: 120000,
      role: 'planning',
    },
    'auditor': {
      model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro', variant: 'high' },
      agent: 'gateway-auditor',
      skills: ['gateway-stage'],
      permission: { '': 'ask', gateway_: 'allow', 'gateway_*': 'allow', read: 'allow', glob: 'allow', grep: 'allow', skill: 'allow', question: 'allow', edit: 'deny', bash: 'deny' },
      heartbeatMs: 0,
      maxTokens: 50000,
      role: 'execution',
    },
  },
  agentTeams: {},
  agentFactory: { blueprintDirs: [] },
  channels: { richMessages: { enabled: true }, telegram: { richMessages: { enabled: true } }, whatsapp: {}, discord: { enabled: false, richMessages: { enabled: true } } },
}

let cachedConfig: GatewayConfig | null = null

export function getConfig(): GatewayConfig {
  if (cachedConfig) return cachedConfig
  try {
    const raw = fs.readFileSync(configFile(), 'utf-8')
    cachedConfig = normalizeConfig(deepMerge(clone(DEFAULTS), JSON.parse(raw)))
    applyPeerHosts(cachedConfig!)
    return cachedConfig!
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw new ConfigError(`Gateway config is invalid: ${configFile()}: ${err?.message || err}`, err)
  }
  cachedConfig = normalizeConfig(clone(DEFAULTS))
  applyPeerHosts(cachedConfig)
  return cachedConfig
}

export function writeConfig(config: GatewayConfig): void {
  const normalized = normalizeConfig(config)
  const dir = configDir()
  const file = configFile()
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  backupExistingFile(file)
  atomicWriteFile(file, JSON.stringify(normalized, null, 2) + '\n')
  cachedConfig = normalized
  applyPeerHosts(normalized)
}

export function updateConfig(input: Partial<GatewayConfig>): GatewayConfig {
  const current = getConfig()
  const next = normalizeConfig(deepMerge(clone(current), input as GatewayConfig))
  writeConfig(next)
  return next
}

export function getProfile(name: string): AgentProfile | undefined {
  return getConfig().profiles[name]
}

export function listProfiles(): Record<string, AgentProfile> {
  return getConfig().profiles
}

export function listAgentTeams(): Record<string, AgentTeamConfig> {
  return getConfig().agentTeams
}

export function getAgentTeam(name: string): AgentTeamConfig | undefined {
  return getConfig().agentTeams[name]
}

export function validateAgentTeamConfig(name: string, team: Partial<AgentTeamConfig>, profiles: Record<string, AgentProfile> = getConfig().profiles): AgentTeamConfig {
  assertProfileName(name)
  if (name === 'default') throw new Error('default agent team is generated from scheduler.stageProfiles')
  return normalizeAgentTeam(team, `agentTeams.${name}`, profiles)
}

export function upsertAgentTeam(name: string, team: Partial<AgentTeamConfig>): AgentTeamConfig {
  const normalized = validateAgentTeamConfig(name, team)
  const config = getConfig()
  writeConfig({ ...config, agentTeams: { ...config.agentTeams, [name]: normalized } })
  return getConfig().agentTeams[name]!
}

export function deleteAgentTeam(name: string): boolean {
  assertProfileName(name)
  if (name === 'default') throw new Error('default agent team cannot be deleted')
  const config = getConfig()
  if (!config.agentTeams[name]) return false
  const agentTeams = { ...config.agentTeams }
  delete agentTeams[name]
  writeConfig({ ...config, agentTeams })
  return true
}

export function agentTeamRevision(team: Omit<AgentTeamConfig, 'revision'> | AgentTeamConfig): string {
  const { revision: _revision, ...input } = team as AgentTeamConfig
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16)
}

export function agentProfileRevision(profile: AgentProfile): string {
  return createHash('sha256').update(stableStringify(profile)).digest('hex').slice(0, 16)
}

export function upsertProfile(name: string, profile: AgentProfile): AgentProfile {
  assertProfileName(name)
  const config = getConfig()
  const next: GatewayConfig = { ...config, profiles: { ...config.profiles, [name]: normalizeProfile(profile) } }
  writeConfig(next)
  return next.profiles[name]!
}

export function validateProfileConfig(name: string, profile: AgentProfile): AgentProfile {
  assertProfileName(name)
  return normalizeProfile(profile)
}

export function deleteProfile(name: string): boolean {
  assertProfileName(name)
  const config = getConfig()
  if (!config.profiles[name]) return false
  const profiles = { ...config.profiles }
  delete profiles[name]
  writeConfig({ ...config, profiles })
  return true
}

export function updateSchedulerConfig(input: Partial<GatewayConfig['scheduler']>): GatewayConfig['scheduler'] {
  const config = getConfig()
  const scheduler = normalizeSchedulerConfig({
    ...config.scheduler,
    ...input,
    defaultPipeline: input.defaultPipeline?.length ? input.defaultPipeline : config.scheduler.defaultPipeline,
    stageProfiles: input.stageProfiles ? { ...config.scheduler.stageProfiles, ...input.stageProfiles } : config.scheduler.stageProfiles,
    stageConcurrency: input.stageConcurrency ? { ...config.scheduler.stageConcurrency, ...input.stageConcurrency } : config.scheduler.stageConcurrency,
    profileConcurrency: input.profileConcurrency ? { ...config.scheduler.profileConcurrency, ...input.profileConcurrency } : config.scheduler.profileConcurrency,
    capacity: mergeSchedulerCapacity(config.scheduler.capacity, input.capacity),
    reviewGateIsolation: input.reviewGateIsolation ? { ...config.scheduler.reviewGateIsolation, ...input.reviewGateIsolation } : config.scheduler.reviewGateIsolation,
  }, config.profiles)
  writeConfig({ ...config, scheduler })
  return scheduler
}

export function clearConfigCacheForTest(): void {
  cachedConfig = null
}

export function normalizeSchedulerConfig(input: GatewayConfig['scheduler'], profiles: Record<string, AgentProfile> = getConfig().profiles): GatewayConfig['scheduler'] {
  const defaultPipeline = normalizeStageList(input.defaultPipeline, 'scheduler.defaultPipeline')
  const stageProfiles = normalizeStageProfiles(input.stageProfiles || {}, defaultPipeline, profiles)
  const intervalMs = boundedInteger(input.intervalMs, 1000, 24 * 60 * 60 * 1000, 'scheduler.intervalMs')
  const maxConcurrent = boundedInteger(input.maxConcurrent, 1, 20, 'scheduler.maxConcurrent')
  const retryLimit = boundedInteger(input.retryLimit, 0, 10, 'scheduler.retryLimit')
  const maxRunsPerTask = boundedInteger(input.maxRunsPerTask ?? DEFAULTS.scheduler.maxRunsPerTask, 1, 1000, 'scheduler.maxRunsPerTask')
  return {
    enabled: input.enabled !== false,
    intervalMs,
    maxConcurrent,
    leaseMs: boundedInteger(input.leaseMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000, 'scheduler.leaseMs'),
    retryLimit,
    maxRunsPerTask,
    defaultPipeline,
    stageProfiles,
    stageConcurrency: normalizeConcurrencyMap(input.stageConcurrency || {}, 'scheduler.stageConcurrency'),
    profileConcurrency: normalizeConcurrencyMap(input.profileConcurrency || {}, 'scheduler.profileConcurrency'),
    capacity: normalizeSchedulerCapacity(input.capacity, 'scheduler.capacity'),
    reviewGateIsolation: normalizeReviewGateIsolationConfig(input.reviewGateIsolation, 'scheduler.reviewGateIsolation'),
  }
}

function mergeSchedulerCapacity(
  current: GatewayConfig['scheduler']['capacity'] | undefined,
  input: GatewayConfig['scheduler']['capacity'] | undefined,
): GatewayConfig['scheduler']['capacity'] | undefined {
  if (!input) return current
  return {
    teamConcurrency: input.teamConcurrency ? { ...(current?.teamConcurrency || {}), ...input.teamConcurrency } : current?.teamConcurrency || {},
    roadmapConcurrency: input.roadmapConcurrency ? { ...(current?.roadmapConcurrency || {}), ...input.roadmapConcurrency } : current?.roadmapConcurrency || {},
    channelConcurrency: input.channelConcurrency ? { ...(current?.channelConcurrency || {}), ...input.channelConcurrency } : current?.channelConcurrency || {},
  }
}

function normalizeSchedulerCapacity(input: GatewayConfig['scheduler']['capacity'] | undefined, label: string): NonNullable<GatewayConfig['scheduler']['capacity']> {
  return {
    teamConcurrency: normalizeConcurrencyMap(input?.teamConcurrency || {}, `${label}.teamConcurrency`),
    roadmapConcurrency: normalizeConcurrencyMap(input?.roadmapConcurrency || {}, `${label}.roadmapConcurrency`),
    channelConcurrency: normalizeConcurrencyMap(input?.channelConcurrency || {}, `${label}.channelConcurrency`),
  }
}

function normalizeReviewGateIsolationConfig(input: Partial<ReviewGateIsolationConfig> | undefined, label: string): ReviewGateIsolationConfig {
  const defaults = DEFAULTS.scheduler.reviewGateIsolation
  return {
    enabled: input?.enabled !== false,
    stages: normalizeStageList((input?.stages?.length ? input.stages : defaults.stages), `${label}.stages`),
    deniedTools: normalizeCapabilityList(input?.deniedTools || defaults.deniedTools, `${label}.deniedTools`),
    allowBashEvidenceCommands: input?.allowBashEvidenceCommands !== false,
    bashAllowlist: normalizeBashAllowlist(input?.bashAllowlist || defaults.bashAllowlist, `${label}.bashAllowlist`),
    forbiddenPathHints: normalizeOutputRequirementList(input?.forbiddenPathHints || defaults.forbiddenPathHints, `${label}.forbiddenPathHints`),
  }
}

function normalizeBashAllowlist(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  const values = input.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`${label}[${index}] must be a string`)
    const text = value.trim()
    if (!text || text.length > 256) throw new Error(`${label}[${index}] must be 1-256 characters`)
    if (/[;&|`$<>\r\n]/.test(text)) throw new Error(`${label}[${index}] contains shell control characters`)
    return text
  })
  return [...new Set(values)]
}

function normalizeConcurrencyMap(input: Record<string, number>, label: string): Record<string, number> {
  const normalized: Record<string, number> = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(key)) throw new Error(`${label} contains invalid key: ${key}`)
    normalized[key] = boundedInteger(value, 1, 100, `${label}.${key}`)
  }
  return normalized
}

function normalizeProfile(profile: AgentProfile): AgentProfile {
  if (!profile?.model?.providerID || !profile.model.modelID) throw new Error('profile.model.providerID and profile.model.modelID are required')
  const normalized: AgentProfile = {
    description: normalizeOptionalText(profile.description, 1000),
    model: profile.model,
    agent: profile.agent || 'build',
    skills: normalizeCapabilityList(profile.skills || [], 'profile.skills'),
    mcpServers: normalizeOptionalCapabilityList(profile.mcpServers, 'profile.mcpServers'),
    tools: normalizeOptionalCapabilityList(profile.tools, 'profile.tools'),
    permission: normalizePermissionMap(profile.permission || {}, 'profile.permission'),
    heartbeatMs: Number(profile.heartbeatMs || 0),
    maxTokens: Number(profile.maxTokens || 50000),
    role: normalizeProfileRole(profile.role),
    environment: normalizeEnvironmentSelector(profile.environment, 'profile.environment'),
    capabilities: normalizeOptionalCapabilityList(profile.capabilities, 'profile.capabilities'),
    budget: normalizeAgentBudget(profile.budget, 'profile.budget'),
    outputContract: normalizeAgentOutputContract(profile.outputContract, 'profile.outputContract'),
    promotionState: normalizeAgentPromotionState(profile.promotionState, 'profile.promotionState'),
  }
  const version = normalizeOptionalVersion(profile.version, 'profile.version')
  const updatedAt = normalizeOptionalTimestamp(profile.updatedAt, 'profile.updatedAt')
  if (version) normalized.version = version
  if (updatedAt) normalized.updatedAt = updatedAt
  return normalized
}

// --- Zod schema (defense-in-depth validation of the NORMALIZED config) ---
//
// This schema models the *output* of the normalize* pipeline: every field's
// type, and — critically — the exact numeric bounds and enums the hand-rolled
// validators enforce. It runs after normalizeConfig() produces its result, as a
// belt-and-suspenders assertion that the effective config is well-formed. It is
// deliberately strict on the bounded/enum fields (where operator mistakes and
// normalize regressions are caught) and permissive on open-ended shapes
// (arbitrary permission keys, qualitySpecDefaults, model records, the
// externally-owned environments registry) so it can never reject a config the
// normalizer legitimately produced. Because the operator-facing messages are
// still emitted by the normalizers (which run first), all existing config tests
// keep their exact error strings; this layer only fires on a normalizer bug,
// naming the offending JSON path when it does.
//
// zObject() below is a plain z.object (unknown keys are stripped, not rejected),
// keeping the schema permissive to forward-compatible additions.

const zLooseNumber = z.number().or(z.nan())
const zBoolean = z.boolean()
const zString = z.string()
const zStringArray = z.array(z.string())
function zBoundedInt(min: number, max: number) {
  return z.number().int().min(min).max(max)
}
function zBoundedNumber(min: number, max: number) {
  return z.number().min(min).max(max)
}
function zConcurrencyMap() {
  return zStringRecord(zBoundedInt(1, 100))
}

const zGovernanceAction = z.enum(['block', 'pause', 'warn'])
const zGovernanceBudget = z.object({
  dailyCostUsd: zBoundedNumber(0, 1_000_000).optional(),
  weeklyCostUsd: zBoundedNumber(0, 1_000_000).optional(),
  monthlyCostUsd: zBoundedNumber(0, 1_000_000).optional(),
  totalCostUsd: zBoundedNumber(0, 1_000_000).optional(),
  tokenLimit: zBoundedInt(0, 10_000_000_000).optional(),
  action: zGovernanceAction.optional(),
})

const zChannelAllowlistRule = z.object({
  chatId: zString,
  threadId: zString.optional(),
  userIds: zStringArray.optional(),
  adminUserIds: zStringArray.optional(),
})

const zExposedHttp = z.object({
  requireStrongToken: zBoolean,
  minTokenLength: zBoundedInt(8, 512),
  minTokenEntropyBits: zBoundedInt(0, 512),
  trustedProxyCidrs: zStringArray.optional(),
  rateLimit: z.object({
    enabled: zBoolean,
    windowMs: zBoundedInt(100, 60 * 60 * 1000),
    maxRequests: zBoundedInt(1, 1_000_000),
    maxTrackedClients: zBoundedInt(1, 1_000_000),
  }),
  authLockout: z.object({
    enabled: zBoolean,
    maxConsecutiveFailures: zBoundedInt(1, 10_000),
    lockoutMs: zBoundedInt(100, 24 * 60 * 60 * 1000),
  }),
})

const zSecurity = z.object({
  httpHost: zString,
  allowNonLocalHttp: zBoolean,
  publicWebhookMode: zBoolean,
  unsafeAllowNoAuth: zBoolean,
  capabilityScopedLoopback: zBoolean.optional(),
  requireNonMcpDestructiveApproval: zBoolean.optional(),
  exposedHttp: zExposedHttp.optional(),
  trustTargetMembersForFreeText: zBoolean,
  unsafeAllowAllChannelTargets: z.object({ telegram: zBoolean, whatsapp: zBoolean, discord: zBoolean }),
  channelAllowlists: z.object({
    telegram: z.array(zChannelAllowlistRule),
    whatsapp: z.array(zChannelAllowlistRule),
    discord: z.array(zChannelAllowlistRule),
  }),
})

const zGovernance = z.object({
  enabled: zBoolean,
  action: zGovernanceAction,
  global: zGovernanceBudget,
  roadmaps: zStringRecord(zGovernanceBudget),
  tasks: zStringRecord(zGovernanceBudget),
  stages: zStringRecord(zGovernanceBudget),
  runtime: z.object({
    maxRunMs: zBoundedNumber(0, 30 * 24 * 60 * 60 * 1000),
    staleRunMs: zBoundedNumber(0, 30 * 24 * 60 * 60 * 1000),
  }),
})

const zHumanLoop = z.object({
  enabled: zBoolean,
  taskStartApproval: zBoolean,
  stageApprovals: zStringArray,
  externalSideEffectApproval: zBoolean,
  budgetExceptionApproval: zBoolean,
  destructiveActionApproval: zBoolean,
  credentialUseApproval: zBoolean,
  defaultTimeoutMs: zBoundedInt(1000, 30 * 24 * 60 * 60 * 1000),
  timeoutAction: z.enum(['remind', 'escalate', 'pause', 'block']),
  priorityTimeoutMs: z.object({
    HIGH: zBoundedInt(1000, 30 * 24 * 60 * 60 * 1000),
    MEDIUM: zBoundedInt(1000, 30 * 24 * 60 * 60 * 1000),
    LOW: zBoundedInt(1000, 30 * 24 * 60 * 60 * 1000),
  }),
})

const zAlerts = z.object({
  profileHealth: z.object({
    enabled: zBoolean,
    windowDays: zBoundedInt(1, 365),
    minRuns: zBoundedInt(1, 100_000),
    maxGenuineFailureRate: zBoundedNumber(0, 1),
  }),
  stuckTask: z.object({
    enabled: zBoolean,
    runThreshold: zBoundedInt(1, 1000),
  }),
  delivery: z.object({
    enabled: zBoolean,
    maxAttempts: zBoundedInt(1, 100),
    targets: z.array(z.object({
      provider: z.enum(['telegram', 'whatsapp', 'discord']),
      chatId: zString,
      threadId: zString.optional(),
      minimumSeverity: z.enum(['warning', 'critical']),
    })),
  }),
})

const zProfile = z.object({
  version: zString.optional(),
  updatedAt: zString.optional(),
  description: zString.optional(),
  model: zStringRecord(z.unknown()),
  agent: zString,
  skills: zStringArray,
  mcpServers: zStringArray.optional(),
  tools: zStringArray.optional(),
  permission: zStringRecord(z.enum(['allow', 'ask', 'deny'])),
  heartbeatMs: zLooseNumber,
  maxTokens: zLooseNumber,
  role: z.enum(['planning', 'execution']),
  environment: z.unknown().optional(),
  capabilities: zStringArray.optional(),
  budget: z
    .object({
      maxTokens: zBoundedInt(0, 10_000_000_000).optional(),
      maxCostUsd: zBoundedNumber(0, 1_000_000).optional(),
      maxRuntimeMs: zBoundedInt(0, 30 * 24 * 60 * 60 * 1000).optional(),
      retryLimit: zBoundedInt(0, 10).optional(),
      humanGate: z.enum(['never', 'on-risk', 'always']).optional(),
    })
    .optional(),
  outputContract: z
    .object({
      format: z.enum(['text', 'json', 'stage-result', 'supervisor-result']).optional(),
      schema: zStringRecord(z.unknown()).optional(),
      requiredEvidence: zStringArray.optional(),
      requiredDecisions: zStringArray.optional(),
      artifactRefs: zBoolean.optional(),
      failureClass: zBoolean.optional(),
    })
    .optional(),
  promotionState: z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']).optional(),
})

const zAgentTeam = z.object({
  description: zString.optional(),
  version: zString.optional(),
  updatedAt: zString.optional(),
  promotionState: z.enum(['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']).optional(),
  roles: zStringRecord(zString),
  capabilityRequirements: zStringRecord(zStringArray),
  qualitySpecDefaults: zStringRecord(z.unknown()),
  revision: zString,
})

const zScheduler = z.object({
  enabled: zBoolean,
  intervalMs: zBoundedInt(1000, 24 * 60 * 60 * 1000),
  maxConcurrent: zBoundedInt(1, 20),
  leaseMs: zBoundedInt(60 * 1000, 7 * 24 * 60 * 60 * 1000),
  retryLimit: zBoundedInt(0, 10),
  maxRunsPerTask: zBoundedInt(1, 1000),
  defaultPipeline: z.array(zString).min(1),
  stageProfiles: zStringRecord(zString),
  stageConcurrency: zConcurrencyMap(),
  profileConcurrency: zConcurrencyMap(),
  capacity: z
    .object({
      teamConcurrency: zConcurrencyMap(),
      roadmapConcurrency: zConcurrencyMap(),
      channelConcurrency: zConcurrencyMap(),
    })
    .optional(),
  reviewGateIsolation: z.object({
    enabled: zBoolean,
    stages: zStringArray,
    deniedTools: zStringArray,
    allowBashEvidenceCommands: zBoolean,
    bashAllowlist: zStringArray,
    forbiddenPathHints: zStringArray,
  }),
})

const zChannels = z.object({
  richMessages: z.object({ enabled: zBoolean }),
  telegram: z.object({ botToken: zString.optional(), richMessages: z.object({ enabled: zBoolean }).optional() }),
  whatsapp: zStringRecord(z.unknown()),
  discord: z.object({
    enabled: zBoolean,
    botToken: zString.optional(),
    applicationId: zString.optional(),
    publicKey: zString.optional(),
    richMessages: z.object({ enabled: zBoolean }).optional(),
  }),
})

export const GatewayConfigSchema = z.object({
  opencodeConfigDir: z.unknown().optional(),
  opencodeUrl: zString.min(1),
  opencodePeers: zStringRecord(z.object({
    baseUrl: zString.min(1),
    default: zBoolean.optional(),
    allowHostnames: zStringArray.optional(),
    basicAuth: z.object({
      usernameEnv: zString.optional(),
      passwordEnv: zString.optional(),
      passwordFile: zString.optional(),
    }).optional(),
    requireHttps: zBoolean.optional(),
  })).optional(),
  httpPort: zBoundedInt(1, 65535),
  heartbeat: z.object({ intervalMs: zBoundedInt(1000, 24 * 60 * 60 * 1000) }),
  channelSync: z.object({
    enabled: zBoolean,
    intervalMs: zBoundedInt(1000, 24 * 60 * 60 * 1000),
    includeUserMessages: zBoolean,
    providerBackoffMs: zBoundedInt(1000, 24 * 60 * 60 * 1000).optional(),
    maxDeliveryAttempts: zBoundedInt(1, 100).optional(),
  }),
  security: zSecurity,
  governance: zGovernance,
  humanLoop: zHumanLoop,
  alerts: zAlerts,
  storage: z.object({
    backend: z.enum(['local_sqlite']),
    retention: z.object({
      runsMaxAgeDays: zBoundedInt(60, 3650).optional(),
      receiptsMaxAgeDays: zBoundedInt(7, 3650).optional(),
    }).optional(),
  }),
  secretLifecycle: z.unknown().optional(),
  environments: zStringRecord(z.unknown()),
  scheduler: zScheduler,
  profiles: zStringRecord(zProfile),
  agentTeams: zStringRecord(zAgentTeam),
  agentFactory: z.object({ blueprintDirs: zStringArray }),
  channels: zChannels,
})

/**
 * Assert the normalized config satisfies the zod schema. Fires only on a
 * normalizer regression; names the offending JSON path when it does, preserving
 * the `Gateway config is invalid` surface the daemon relies on.
 */
function assertNormalizedConfig(config: GatewayConfig): GatewayConfig {
  const result = GatewayConfigSchema.safeParse(config)
  if (!result.success) {
    const issue = result.error.issues[0]
    const jsonPath = issue?.path.join('.') || '<root>'
    throw new ConfigError(`Gateway config is invalid: ${jsonPath}: ${issue?.message || 'schema validation failed'}`)
  }
  return config
}

function normalizeConfig(config: GatewayConfig): GatewayConfig {
  const profiles = Object.fromEntries(Object.entries(config.profiles || {}).map(([name, profile]) => {
    assertProfileName(name)
    return [name, normalizeProfile(profile)]
  }))
  const scheduler = normalizeSchedulerConfig(config.scheduler, profiles)
  const normalized: GatewayConfig = {
    opencodeConfigDir: config.opencodeConfigDir,
    opencodeUrl: config.opencodeUrl || DEFAULTS.opencodeUrl,
    opencodePeers: normalizeOpenCodePeers(config.opencodePeers),
    httpPort: boundedInteger(config.httpPort, 1, 65535, 'httpPort'),
    heartbeat: { intervalMs: boundedInteger(config.heartbeat?.intervalMs, 1000, 24 * 60 * 60 * 1000, 'heartbeat.intervalMs') },
    channelSync: {
      enabled: config.channelSync?.enabled !== false,
      intervalMs: boundedInteger(config.channelSync?.intervalMs, 1000, 24 * 60 * 60 * 1000, 'channelSync.intervalMs'),
      includeUserMessages: config.channelSync?.includeUserMessages !== false,
      providerBackoffMs: boundedInteger(config.channelSync?.providerBackoffMs ?? DEFAULTS.channelSync.providerBackoffMs, 1000, 24 * 60 * 60 * 1000, 'channelSync.providerBackoffMs'),
      maxDeliveryAttempts: boundedInteger(config.channelSync?.maxDeliveryAttempts ?? DEFAULTS.channelSync.maxDeliveryAttempts, 1, 100, 'channelSync.maxDeliveryAttempts'),
    },
    security: normalizeSecurityConfig(config.security),
    governance: normalizeGovernanceConfig(config.governance),
    humanLoop: normalizeHumanLoopConfig(config.humanLoop),
    alerts: normalizeAlertsConfig(config.alerts, scheduler.maxRunsPerTask),
    storage: normalizeStorageConfig(config.storage),
    environments: normalizeGatewayEnvironmentConfig(config.environments),
    profiles,
    scheduler,
    agentTeams: normalizeAgentTeams(config.agentTeams || {}, scheduler, profiles),
    agentFactory: normalizeAgentFactoryConfig(config.agentFactory),
    channels: normalizeChannelsConfig(config.channels),
  }
  return assertNormalizedConfig(applyEnvironmentConfigOverrides(normalized))
}

function applyPeerHosts(config: GatewayConfig): void {
  const hosts = new Set<string>()
  for (const peer of Object.values(config.opencodePeers || {})) {
    for (const host of peer.allowHostnames || []) hosts.add(String(host || '').trim().toLowerCase())
    try {
      hosts.add(new URL(peer.baseUrl).hostname.toLowerCase())
    } catch {
      // ignore
    }
  }
  setTrustedOpenCodePeerHosts([...hosts].filter(Boolean))
}

function normalizeOpenCodePeers(input: GatewayConfig['opencodePeers'] | undefined): NonNullable<GatewayConfig['opencodePeers']> {
  const peers: NonNullable<GatewayConfig['opencodePeers']> = {}
  for (const [name, peer] of Object.entries(input || {})) {
    if (!peer || typeof peer !== 'object') continue
    const baseUrl = String(peer.baseUrl || '').trim()
    if (!baseUrl) throw new Error(`opencodePeers.${name}.baseUrl is required`)
    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      throw new Error(`opencodePeers.${name}.baseUrl is invalid`)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`opencodePeers.${name}.baseUrl must be http(s)`)
    }
    if (parsed.username || parsed.password) {
      throw new Error(`opencodePeers.${name}.baseUrl must not embed credentials; use basicAuth env/file fields`)
    }
    if (peer.requireHttps && parsed.protocol !== 'https:') {
      throw new Error(`opencodePeers.${name} requires https`)
    }
    const allowHostnames = Array.isArray(peer.allowHostnames)
      ? peer.allowHostnames.map(h => String(h || '').trim().toLowerCase()).filter(Boolean)
      : [parsed.hostname.toLowerCase()]
    if (!allowHostnames.includes(parsed.hostname.toLowerCase())) {
      allowHostnames.push(parsed.hostname.toLowerCase())
    }
    // Screen every trusted-fetch host against the SSRF-classic dangerous ranges:
    // cloud metadata / link-local (169.254.x incl. 169.254.169.254), the
    // unspecified address (0.0.0.0/::), and the metadata DNS name. Private LAN
    // ranges (10.x/172.16.x/192.168.x) are intentionally allowed — a peer
    // OpenCode instance on the operator's own network is a legitimate use.
    for (const host of allowHostnames) {
      if (isForbiddenPeerHost(host)) {
        throw new Error(`opencodePeers.${name} host is not allowed (link-local/metadata/unspecified address): ${host}`)
      }
      if (parsed.protocol === 'http:' && isNonLocalHostname(host)) {
        throw new Error(`opencodePeers.${name} non-local peers require https: ${host}`)
      }
    }
    peers[name] = {
      baseUrl: baseUrl.replace(/\/$/, ''),
      default: peer.default === true,
      allowHostnames,
      basicAuth: peer.basicAuth,
      requireHttps: peer.requireHttps === true,
    }
  }
  return peers
}

function isNonLocalHostname(host: string): boolean {
  const value = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  if (!value || value === 'localhost') return false
  if (net.isIP(value)) return !isLoopbackIp(value)
  if (value === 'host.docker.internal') return false
  return true
}

function isLoopbackIp(value: string): boolean {
  if (net.isIPv4(value)) return value.startsWith('127.')
  if (!value.includes(':')) return false
  const bytes = ipv6ToBytes(value)
  if (!bytes) return false
  const ipv4Mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
  if (ipv4Mapped) return bytes[12] === 127
  return bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1
}

/** SSRF-classic hosts that must never be a trusted OpenCode peer fetch target. */
function isForbiddenPeerHost(host: string): boolean {
  const value = String(host || '').trim().toLowerCase().replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '')
  if (!value) return true
  if (value === 'metadata.google.internal' || value === 'metadata') return true
  // Parse numerically rather than pattern-match the serialized string: a
  // link-local/metadata target can hide behind decimal/hex IPv4 forms or an
  // IPv4-mapped IPv6 literal (e.g. [::ffff:169.254.169.254], which WHATWG URL
  // serializes to [::ffff:a9fe:a9fe]).
  if (net.isIPv4(value)) return isForbiddenIpv4Octets(value.split('.').map(Number))
  if (value.includes(':')) {
    const bytes = ipv6ToBytes(value)
    if (!bytes) return true // unparseable IPv6 literal → fail closed
    if (bytes.every(byte => byte === 0)) return true                       // :: unspecified
    if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return true       // fe80::/10 link-local
    const ipv4Mapped = bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff
    if (ipv4Mapped) return isForbiddenIpv4Octets([bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!])
    return false
  }
  return false // plain hostname: the exact-match allowlist governs trust
}

function isForbiddenIpv4Octets(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  if (octets[0] === 0) return true                       // 0.0.0.0/8 (incl. unspecified)
  if (octets[0] === 169 && octets[1] === 254) return true // 169.254.0.0/16 link-local / cloud metadata
  return false
}

/** Expand an IPv6 literal (incl. an embedded dotted-quad tail) to 16 bytes, or null if malformed. */
function ipv6ToBytes(addr: string): number[] | null {
  let text = addr
  const dotted = text.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (dotted) {
    const octets = [Number(dotted[2]), Number(dotted[3]), Number(dotted[4]), Number(dotted[5])]
    if (octets.some(n => n > 255)) return null
    text = `${dotted[1]}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 0) return null
    groups = [...head, ...Array(fill).fill('0'), ...tail]
  } else {
    groups = head
  }
  if (groups.length !== 8) return null
  const bytes: number[] = []
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null
    const value = parseInt(group, 16)
    bytes.push((value >> 8) & 0xff, value & 0xff)
  }
  return bytes
}

function applyEnvironmentConfigOverrides(config: GatewayConfig, env: EnvSource = process.env): GatewayConfig {
  const next = clone(config)
  const opencodeUrl = gatewayEnv.opencodeUrl(env)
  if (opencodeUrl) next.opencodeUrl = opencodeUrl
  const port = gatewayEnv.httpPort(env)
  if (port !== undefined && port !== '') next.httpPort = parseHttpPortEnv(port)
  const host = gatewayEnv.httpHost(env)
  if (host) next.security.httpHost = normalizeSecurityConfig({ ...next.security, httpHost: host }).httpHost
  const allowNonLocalHttp = gatewayEnv.allowNonLocalHttp(env)
  if (allowNonLocalHttp !== undefined) next.security.allowNonLocalHttp = allowNonLocalHttp
  const publicWebhookMode = gatewayEnv.publicWebhookMode(env)
  if (publicWebhookMode !== undefined) next.security.publicWebhookMode = publicWebhookMode
  const unsafeAllowNoAuth = gatewayEnv.unsafeAllowNoAuth(env)
  if (unsafeAllowNoAuth !== undefined) next.security.unsafeAllowNoAuth = unsafeAllowNoAuth
  const capabilityScopedLoopback = gatewayEnv.capabilityScopedLoopback(env)
  if (capabilityScopedLoopback !== undefined) next.security.capabilityScopedLoopback = capabilityScopedLoopback
  const requireNonMcpDestructiveApproval = gatewayEnv.requireNonMcpDestructiveApproval(env)
  if (requireNonMcpDestructiveApproval !== undefined) next.security.requireNonMcpDestructiveApproval = requireNonMcpDestructiveApproval
  return next
}

function parseHttpPortEnv(value: string): number {
  const trimmed = value.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) throw new Error('OPENCODE_GATEWAY_HTTP_PORT must be an integer between 1 and 65535')
  return boundedInteger(Number(trimmed), 1, 65535, 'OPENCODE_GATEWAY_HTTP_PORT')
}

function normalizeAgentFactoryConfig(input: Partial<GatewayConfig['agentFactory']> | undefined): GatewayConfig['agentFactory'] {
  return {
    blueprintDirs: normalizePathList(input?.blueprintDirs || [], 'agentFactory.blueprintDirs'),
  }
}

function normalizeChannelsConfig(input: Partial<GatewayConfig['channels']> | undefined): GatewayConfig['channels'] {
  return {
    richMessages: { enabled: input?.richMessages?.enabled !== false },
    telegram: {
      botToken: normalizeOptionalText(input?.telegram?.botToken, 4096),
      richMessages: { enabled: input?.telegram?.richMessages?.enabled !== false },
    },
    whatsapp: {
      setupMode: normalizeWhatsAppSetupMode(input?.whatsapp?.setupMode, 'channels.whatsapp.setupMode'),
      accessToken: normalizeOptionalText(input?.whatsapp?.accessToken, 4096),
      phoneNumberId: normalizeOptionalText(input?.whatsapp?.phoneNumberId, 256),
      verifyToken: normalizeOptionalText(input?.whatsapp?.verifyToken, 4096),
      appSecret: normalizeOptionalText(input?.whatsapp?.appSecret, 4096),
    },
    discord: {
      enabled: input?.discord?.enabled === true,
      botToken: normalizeOptionalText(input?.discord?.botToken, 4096),
      applicationId: normalizeOptionalText(input?.discord?.applicationId, 256),
      publicKey: normalizeOptionalText(input?.discord?.publicKey, 256),
      richMessages: { enabled: input?.discord?.richMessages?.enabled !== false },
    },
  }
}

function normalizeAlertsConfig(input: Partial<AlertsConfig> | undefined, maxRunsPerTask?: number): AlertsConfig {
  const ph = input?.profileHealth
  const defaults = DEFAULTS.alerts.profileHealth
  const st = input?.stuckTask
  const stDefaults = DEFAULTS.alerts.stuckTask
  const delivery = input?.delivery
  const deliveryDefaults = DEFAULTS.alerts.delivery
  let runThreshold = boundedInteger(st?.runThreshold ?? stDefaults.runThreshold, 1, 1000, 'alerts.stuckTask.runThreshold')
  // The stuck-task warn line must sit strictly below the hard run cap. A task is
  // blocked once its run count reaches maxRunsPerTask, which freezes the count
  // there — so a runThreshold at or above the cap could never be crossed and the
  // alert would never warn before the block. Clamp it to cap-1 (floored at 1) so
  // the operator is always warned before the cap blocks the task.
  if (maxRunsPerTask !== undefined && runThreshold >= maxRunsPerTask) {
    const clamped = Math.max(1, maxRunsPerTask - 1)
    if (clamped !== runThreshold) {
      console.warn(`[config] alerts.stuckTask.runThreshold (${runThreshold}) >= scheduler.maxRunsPerTask (${maxRunsPerTask}); clamped to ${clamped} so the stuck-task alert warns before the run cap blocks the task.`)
    }
    runThreshold = clamped
  }
  return {
    profileHealth: {
      enabled: ph?.enabled !== false,
      windowDays: boundedInteger(ph?.windowDays ?? defaults.windowDays, 1, 365, 'alerts.profileHealth.windowDays'),
      minRuns: boundedInteger(ph?.minRuns ?? defaults.minRuns, 1, 100_000, 'alerts.profileHealth.minRuns'),
      maxGenuineFailureRate: boundedNumber(ph?.maxGenuineFailureRate ?? defaults.maxGenuineFailureRate, 0, 1, 'alerts.profileHealth.maxGenuineFailureRate'),
    },
    stuckTask: {
      enabled: st?.enabled !== false,
      runThreshold,
    },
    delivery: {
      enabled: delivery?.enabled === true,
      maxAttempts: boundedInteger(delivery?.maxAttempts ?? deliveryDefaults.maxAttempts, 1, 100, 'alerts.delivery.maxAttempts'),
      targets: normalizeAlertDeliveryTargets(delivery?.targets || []),
    },
  }
}

function normalizeAlertDeliveryTargets(input: AlertsConfig['delivery']['targets']): AlertsConfig['delivery']['targets'] {
  if (!Array.isArray(input)) throw new Error('alerts.delivery.targets must be an array')
  const seen = new Set<string>()
  return input.map((target, index) => {
    const provider = target?.provider
    const chatId = String(target?.chatId || '').trim()
    const threadId = String(target?.threadId || '').trim() || undefined
    const minimumSeverity = target?.minimumSeverity || 'critical'
    if (!['telegram', 'whatsapp', 'discord'].includes(provider)) throw new Error(`alerts.delivery.targets[${index}].provider is invalid`)
    if (!chatId || chatId.length > 256) throw new Error(`alerts.delivery.targets[${index}].chatId must be 1-256 characters`)
    if (threadId && threadId.length > 256) throw new Error(`alerts.delivery.targets[${index}].threadId must be <= 256 characters`)
    if (minimumSeverity !== 'warning' && minimumSeverity !== 'critical') throw new Error(`alerts.delivery.targets[${index}].minimumSeverity is invalid`)
    const key = `${provider}:${chatId}:${threadId || ''}`
    if (seen.has(key)) throw new Error(`alerts.delivery.targets[${index}] duplicates an earlier target`)
    seen.add(key)
    return { provider, chatId, ...(threadId ? { threadId } : {}), minimumSeverity } as AlertsConfig['delivery']['targets'][number]
  })
}

function normalizeStorageConfig(input: Partial<StorageConfig> | undefined): StorageConfig {
  const backend = normalizeStorageBackendMode(input?.backend, 'storage.backend')
  const retention = {
    runsMaxAgeDays: boundedInteger(input?.retention?.runsMaxAgeDays ?? DEFAULTS.storage.retention.runsMaxAgeDays, 60, 3650, 'storage.retention.runsMaxAgeDays'),
    receiptsMaxAgeDays: boundedInteger(input?.retention?.receiptsMaxAgeDays ?? DEFAULTS.storage.retention.receiptsMaxAgeDays, 7, 3650, 'storage.retention.receiptsMaxAgeDays'),
  }
  return { backend, retention }
}

function normalizeStorageBackendMode(input: unknown, label: string): StorageBackendMode {
  if (input === undefined || input === null || input === '') return 'local_sqlite'
  if (input === 'local_sqlite') return input
  throw new Error(`${label} must be local_sqlite`)
}

function normalizeWhatsAppSetupMode(input: unknown, label: string): GatewayConfig['channels']['whatsapp']['setupMode'] {
  if (input === undefined || input === null || input === '') return undefined
  if (input === 'cloudApiDirect') return input
  throw new Error(`${label} must be cloudApiDirect`)
}

function normalizeAgentTeams(input: Record<string, Partial<AgentTeamConfig>>, scheduler: GatewayConfig['scheduler'], profiles: Record<string, AgentProfile>): Record<string, AgentTeamConfig> {
  const normalized: Record<string, AgentTeamConfig> = {}
  for (const [name, team] of Object.entries(input || {})) {
    assertProfileName(name)
    if (name === 'default') continue
    normalized[name] = normalizeAgentTeam(team, `agentTeams.${name}`, profiles)
  }
  normalized['default'] = normalizeAgentTeam({
    ...(input['default'] || {}),
    description: input['default']?.description || 'Default Gateway team generated from scheduler.stageProfiles.',
    roles: scheduler.stageProfiles,
  }, 'agentTeams.default', profiles)
  return normalized
}

function normalizeAgentTeam(input: Partial<AgentTeamConfig> | undefined, label: string, profiles: Record<string, AgentProfile>): AgentTeamConfig {
  const roles = normalizeAgentTeamRoles(input?.roles || {}, `${label}.roles`, profiles)
  const capabilityRequirements = normalizeAgentTeamCapabilityRequirements(input?.capabilityRequirements || {}, `${label}.capabilityRequirements`)
  const qualitySpecDefaults = normalizePlainObject(input?.qualitySpecDefaults || {}, `${label}.qualitySpecDefaults`)
  const team: Omit<AgentTeamConfig, 'revision'> = {
    description: normalizeOptionalText(input?.description, 1000),
    roles,
    capabilityRequirements,
    qualitySpecDefaults,
  }
  const version = normalizeOptionalVersion(input?.version, `${label}.version`)
  const updatedAt = normalizeOptionalTimestamp(input?.updatedAt, `${label}.updatedAt`)
  const promotionState = normalizeAgentPromotionState(input?.promotionState, `${label}.promotionState`)
  if (version) team.version = version
  if (updatedAt) team.updatedAt = updatedAt
  if (promotionState) team.promotionState = promotionState
  return { ...team, revision: agentTeamRevision(team) }
}

function normalizeAgentTeamRoles(input: Record<string, string>, label: string, profiles: Record<string, AgentProfile>): Record<string, string> {
  const roles: Record<string, string> = {}
  for (const [stage, profileName] of Object.entries(input || {})) {
    const normalizedStage = stage === 'default' ? 'default' : normalizeStageName(stage, `${label}.${stage}`)
    const profile = normalizeProfileReference(profileName, `${label}.${stage}`, profiles)
    roles[normalizedStage] = profile
  }
  if (!Object.keys(roles).length) roles['default'] = 'implementer'
  if (!roles['default']) roles['default'] = roles['implement'] || Object.values(roles)[0]!
  const defaultRole = roles['default']!
  if (!profiles[defaultRole]) throw new Error(`${label}.default references missing profile: ${defaultRole}`)
  return roles
}

function normalizeAgentTeamCapabilityRequirements(input: Record<string, unknown>, label: string): Record<string, string[]> {
  const requirements: Record<string, string[]> = {}
  for (const [stage, values] of Object.entries(input || {})) {
    const normalizedStage = stage === 'default' ? 'default' : normalizeStageName(stage, `${label}.${stage}`)
    if (!Array.isArray(values)) throw new Error(`${label}.${stage} must be an array`)
    requirements[normalizedStage] = [...new Set(values.map((value, index) => normalizeCapabilityName(value, `${label}.${stage}[${index}]`)))]
  }
  return requirements
}

function normalizeProfileReference(value: unknown, label: string, profiles: Record<string, AgentProfile>): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a profile name`)
  const profile = value.trim()
  assertProfileName(profile)
  if (!profiles[profile]) throw new Error(`${label} references missing profile: ${profile}`)
  return profile
}

function normalizeCapabilityName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = value.trim()
  if (!/^[a-zA-Z0-9_.:/*-]{1,128}$/.test(text)) throw new Error(`${label} contains invalid capability: ${String(value)}`)
  return text
}

function normalizeCapabilityList(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  return [...new Set(input.map((value, index) => normalizeCapabilityName(value, `${label}[${index}]`)))]
}

function normalizeOptionalCapabilityList(input: unknown, label: string): string[] | undefined {
  if (input === undefined || input === null) return undefined
  const values = normalizeCapabilityList(input, label)
  return values.length ? values : undefined
}

function normalizePermissionMap(input: Record<string, string>, label: string): Record<string, string> {
  const permission: Record<string, string> = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (typeof key !== 'string' || key.length > 128) throw new Error(`${label} contains invalid permission key`)
    if (value !== 'allow' && value !== 'ask' && value !== 'deny') throw new Error(`${label}.${key} must be allow, ask, or deny`)
    permission[key] = value
  }
  return permission
}

function normalizeAgentBudget(input: AgentBudgetContract | undefined, label: string): AgentBudgetContract | undefined {
  if (!input) return undefined
  const budget: AgentBudgetContract = {}
  if (input.maxTokens !== undefined) budget.maxTokens = boundedInteger(input.maxTokens, 0, 10_000_000_000, `${label}.maxTokens`)
  if (input.maxCostUsd !== undefined) budget.maxCostUsd = boundedNumber(input.maxCostUsd, 0, 1_000_000, `${label}.maxCostUsd`)
  if (input.maxRuntimeMs !== undefined) budget.maxRuntimeMs = boundedInteger(input.maxRuntimeMs, 0, 30 * 24 * 60 * 60 * 1000, `${label}.maxRuntimeMs`)
  if (input.retryLimit !== undefined) budget.retryLimit = boundedInteger(input.retryLimit, 0, 10, `${label}.retryLimit`)
  if (input.humanGate !== undefined) budget.humanGate = normalizeHumanGatePolicy(input.humanGate, `${label}.humanGate`)
  return Object.keys(budget).length ? budget : undefined
}

function normalizeAgentOutputContract(input: AgentOutputContract | undefined, label: string): AgentOutputContract | undefined {
  if (!input) return undefined
  const output: AgentOutputContract = {}
  if (input.format !== undefined) output.format = normalizeOutputFormat(input.format, `${label}.format`)
  if (input.schema !== undefined) output.schema = normalizePlainObject(input.schema, `${label}.schema`)
  if (input.requiredEvidence !== undefined) output.requiredEvidence = normalizeOutputRequirementList(input.requiredEvidence, `${label}.requiredEvidence`)
  if (input.requiredDecisions !== undefined) output.requiredDecisions = normalizeOutputRequirementList(input.requiredDecisions, `${label}.requiredDecisions`)
  if (input.artifactRefs !== undefined) output.artifactRefs = input.artifactRefs === true
  if (input.failureClass !== undefined) output.failureClass = input.failureClass === true
  return Object.keys(output).length ? output : undefined
}

function normalizeOutputRequirementList(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  const values = input.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`${label}[${index}] must be a string`)
    const text = value.trim()
    if (!text || text.length > 256) throw new Error(`${label}[${index}] must be 1-256 characters`)
    return text
  })
  return [...new Set(values)]
}

function normalizeHumanGatePolicy(value: unknown, label: string): AgentBudgetContract['humanGate'] {
  if (value === 'never' || value === 'on-risk' || value === 'always') return value
  throw new Error(`${label} must be never, on-risk, or always`)
}

function normalizeOutputFormat(value: unknown, label: string): AgentOutputContract['format'] {
  if (value === 'text' || value === 'json' || value === 'stage-result' || value === 'supervisor-result') return value
  throw new Error(`${label} must be text, json, stage-result, or supervisor-result`)
}

function normalizeAgentPromotionState(value: unknown, label: string): AgentPromotionState | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (value === 'draft' || value === 'evaluated' || value === 'promoted' || value === 'deprecated' || value === 'blocked') return value
  throw new Error(`${label} must be draft, evaluated, promoted, deprecated, or blocked`)
}

function normalizeOptionalVersion(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const version = value.trim()
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(version)) throw new Error(`${label} contains invalid version`)
  return version
}

function normalizeOptionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const text = value.trim()
  if (!text || Number.isNaN(Date.parse(text))) throw new Error(`${label} must be an ISO-8601 timestamp`)
  return new Date(text).toISOString()
}

function normalizePathList(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  const values = input.map((value, index) => {
    if (typeof value !== 'string') throw new Error(`${label}[${index}] must be a string`)
    const text = value.trim()
    if (!text || text.length > 4096) throw new Error(`${label}[${index}] must be 1-4096 characters`)
    return text
  })
  return [...new Set(values)]
}

function normalizePlainObject(value: unknown, label: string): Record<string, unknown> {
  if (!value) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function normalizeOptionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new Error('text field must be a string')
  const text = value.trim()
  return text ? text.substring(0, maxLength) : undefined
}

function normalizeHumanLoopConfig(input: Partial<HumanLoopConfig> | undefined): HumanLoopConfig {
  return {
    enabled: input?.enabled !== false,
    taskStartApproval: input?.taskStartApproval === true,
    stageApprovals: normalizeOptionalStageList(input?.stageApprovals || [], 'humanLoop.stageApprovals'),
    externalSideEffectApproval: input?.externalSideEffectApproval !== false,
    budgetExceptionApproval: input?.budgetExceptionApproval !== false,
    destructiveActionApproval: input?.destructiveActionApproval !== false,
    credentialUseApproval: input?.credentialUseApproval !== false,
    defaultTimeoutMs: boundedInteger(input?.defaultTimeoutMs ?? DEFAULTS.humanLoop.defaultTimeoutMs, 1000, 30 * 24 * 60 * 60 * 1000, 'humanLoop.defaultTimeoutMs'),
    timeoutAction: normalizeHumanGateTimeoutAction(input?.timeoutAction, 'humanLoop.timeoutAction'),
    priorityTimeoutMs: {
      HIGH: boundedInteger(input?.priorityTimeoutMs?.HIGH ?? DEFAULTS.humanLoop.priorityTimeoutMs.HIGH, 1000, 30 * 24 * 60 * 60 * 1000, 'humanLoop.priorityTimeoutMs.HIGH'),
      MEDIUM: boundedInteger(input?.priorityTimeoutMs?.MEDIUM ?? DEFAULTS.humanLoop.priorityTimeoutMs.MEDIUM, 1000, 30 * 24 * 60 * 60 * 1000, 'humanLoop.priorityTimeoutMs.MEDIUM'),
      LOW: boundedInteger(input?.priorityTimeoutMs?.LOW ?? DEFAULTS.humanLoop.priorityTimeoutMs.LOW, 1000, 30 * 24 * 60 * 60 * 1000, 'humanLoop.priorityTimeoutMs.LOW'),
    },
  }
}

function normalizeHumanGateTimeoutAction(value: unknown, label: string): HumanGateTimeoutAction {
  if (value === undefined || value === null || value === '') return 'escalate'
  if (value === 'remind' || value === 'escalate' || value === 'pause' || value === 'block') return value
  throw new Error(`${label} must be remind, escalate, pause, or block`)
}

function normalizeOptionalStageList(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  const stages = input.map((value, index) => normalizeStageName(value, `${label}[${index}]`))
  return [...new Set(stages)]
}

function normalizeStageName(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const stage = value.trim()
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(stage)) throw new Error(`${label} must be 1-64 letters, numbers, underscores, or dashes`)
  return stage
}

function normalizeGovernanceConfig(input: Partial<GovernanceConfig> | undefined): GovernanceConfig {
  return {
    enabled: input?.enabled !== false,
    action: normalizeGovernanceAction(input?.action, 'governance.action'),
    global: normalizeGovernanceBudget(input?.global || {}, 'governance.global'),
    roadmaps: normalizeBudgetMap(input?.roadmaps || {}, 'governance.roadmaps'),
    tasks: normalizeBudgetMap(input?.tasks || {}, 'governance.tasks'),
    stages: normalizeBudgetMap(input?.stages || {}, 'governance.stages'),
    runtime: {
      maxRunMs: boundedNumber(input?.runtime?.maxRunMs ?? 0, 0, 30 * 24 * 60 * 60 * 1000, 'governance.runtime.maxRunMs'),
      staleRunMs: boundedNumber(input?.runtime?.staleRunMs ?? DEFAULTS.governance.runtime.staleRunMs, 0, 30 * 24 * 60 * 60 * 1000, 'governance.runtime.staleRunMs'),
    },
  }
}

function normalizeBudgetMap(input: Record<string, GovernanceBudgetConfig>, label: string): Record<string, GovernanceBudgetConfig> {
  const normalized: Record<string, GovernanceBudgetConfig> = {}
  for (const [key, budget] of Object.entries(input || {})) {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(key)) throw new Error(`${label} contains invalid key: ${key}`)
    normalized[key] = normalizeGovernanceBudget(budget, `${label}.${key}`)
  }
  return normalized
}

function normalizeGovernanceBudget(input: GovernanceBudgetConfig, label: string): GovernanceBudgetConfig {
  const budget: GovernanceBudgetConfig = {}
  if (input.dailyCostUsd !== undefined) budget.dailyCostUsd = boundedNumber(input.dailyCostUsd, 0, 1_000_000, `${label}.dailyCostUsd`)
  if (input.weeklyCostUsd !== undefined) budget.weeklyCostUsd = boundedNumber(input.weeklyCostUsd, 0, 1_000_000, `${label}.weeklyCostUsd`)
  if (input.monthlyCostUsd !== undefined) budget.monthlyCostUsd = boundedNumber(input.monthlyCostUsd, 0, 1_000_000, `${label}.monthlyCostUsd`)
  if (input.totalCostUsd !== undefined) budget.totalCostUsd = boundedNumber(input.totalCostUsd, 0, 1_000_000, `${label}.totalCostUsd`)
  if (input.tokenLimit !== undefined) budget.tokenLimit = boundedInteger(input.tokenLimit, 0, 10_000_000_000, `${label}.tokenLimit`)
  if (input.action !== undefined) budget.action = normalizeGovernanceAction(input.action, `${label}.action`)
  return budget
}

function normalizeGovernanceAction(value: unknown, label: string): GovernanceAction {
  if (value === undefined || value === null || value === '') return 'block'
  if (value === 'block' || value === 'pause' || value === 'warn') return value
  throw new Error(`${label} must be block, pause, or warn`)
}

function normalizeSecurityConfig(input: Partial<SecurityConfig> | undefined): SecurityConfig {
  const httpHost = String(input?.httpHost || DEFAULTS.security.httpHost).trim()
  if (!/^[a-zA-Z0-9.:[\]_-]{1,255}$/.test(httpHost)) throw new Error('security.httpHost contains invalid characters')
  return {
    httpHost,
    allowNonLocalHttp: input?.allowNonLocalHttp === true,
    publicWebhookMode: input?.publicWebhookMode === true,
    unsafeAllowNoAuth: input?.unsafeAllowNoAuth === true,
    capabilityScopedLoopback: input?.capabilityScopedLoopback === undefined ? DEFAULTS.security.capabilityScopedLoopback : input.capabilityScopedLoopback === true,
    requireNonMcpDestructiveApproval: input?.requireNonMcpDestructiveApproval === undefined ? DEFAULTS.security.requireNonMcpDestructiveApproval : input.requireNonMcpDestructiveApproval === true,
    exposedHttp: normalizeExposedHttpSecurityConfig(input?.exposedHttp),
    trustTargetMembersForFreeText: input?.trustTargetMembersForFreeText === true,
    unsafeAllowAllChannelTargets: {
      telegram: input?.unsafeAllowAllChannelTargets?.telegram === true,
      whatsapp: input?.unsafeAllowAllChannelTargets?.whatsapp === true,
      discord: input?.unsafeAllowAllChannelTargets?.discord === true,
    },
    channelAllowlists: {
      telegram: normalizeChannelAllowlist(input?.channelAllowlists?.telegram || [], 'security.channelAllowlists.telegram'),
      whatsapp: normalizeChannelAllowlist(input?.channelAllowlists?.whatsapp || [], 'security.channelAllowlists.whatsapp'),
      discord: normalizeChannelAllowlist(input?.channelAllowlists?.discord || [], 'security.channelAllowlists.discord'),
    },
  }
}

const EXPOSED_HTTP_DEFAULTS: ExposedHttpSecurityConfig = {
  requireStrongToken: true,
  minTokenLength: 16,
  minTokenEntropyBits: 48,
  trustedProxyCidrs: [],
  rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 120, maxTrackedClients: 4096 },
  authLockout: { enabled: true, maxConsecutiveFailures: 5, lockoutMs: 60_000 },
}

function normalizeExposedHttpSecurityConfig(input: Partial<ExposedHttpSecurityConfig> | undefined): ExposedHttpSecurityConfig {
  const defaults = EXPOSED_HTTP_DEFAULTS
  return {
    requireStrongToken: input?.requireStrongToken !== false,
    minTokenLength: boundedInteger(input?.minTokenLength ?? defaults.minTokenLength, 8, 512, 'security.exposedHttp.minTokenLength'),
    minTokenEntropyBits: boundedInteger(input?.minTokenEntropyBits ?? defaults.minTokenEntropyBits, 0, 512, 'security.exposedHttp.minTokenEntropyBits'),
    trustedProxyCidrs: normalizeTrustedProxyCidrs(input?.trustedProxyCidrs ?? defaults.trustedProxyCidrs),
    rateLimit: {
      enabled: input?.rateLimit?.enabled !== false,
      windowMs: boundedInteger(input?.rateLimit?.windowMs ?? defaults.rateLimit.windowMs, 100, 60 * 60 * 1000, 'security.exposedHttp.rateLimit.windowMs'),
      maxRequests: boundedInteger(input?.rateLimit?.maxRequests ?? defaults.rateLimit.maxRequests, 1, 1_000_000, 'security.exposedHttp.rateLimit.maxRequests'),
      maxTrackedClients: boundedInteger(input?.rateLimit?.maxTrackedClients ?? defaults.rateLimit.maxTrackedClients, 1, 1_000_000, 'security.exposedHttp.rateLimit.maxTrackedClients'),
    },
    authLockout: {
      enabled: input?.authLockout?.enabled !== false,
      maxConsecutiveFailures: boundedInteger(input?.authLockout?.maxConsecutiveFailures ?? defaults.authLockout.maxConsecutiveFailures, 1, 10_000, 'security.exposedHttp.authLockout.maxConsecutiveFailures'),
      lockoutMs: boundedInteger(input?.authLockout?.lockoutMs ?? defaults.authLockout.lockoutMs, 100, 24 * 60 * 60 * 1000, 'security.exposedHttp.authLockout.lockoutMs'),
    },
  }
}

function normalizeTrustedProxyCidrs(input: unknown): string[] {
  if (!Array.isArray(input)) throw new Error('security.exposedHttp.trustedProxyCidrs must be an array')
  const normalized = new Set<string>()
  for (const [index, raw] of input.entries()) {
    const value = String(raw || '').trim().toLowerCase()
    const [address, prefixText, extra] = value.split('/')
    const family = net.isIP(address || '')
    if (!value || !family || extra !== undefined) {
      throw new Error(`security.exposedHttp.trustedProxyCidrs[${index}] must be an IPv4 or IPv6 CIDR`)
    }
    const maxPrefix = family === 4 ? 32 : 128
    const prefix = prefixText === undefined ? maxPrefix : Number(prefixText)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`security.exposedHttp.trustedProxyCidrs[${index}] prefix must be 0-${maxPrefix}`)
    }
    normalized.add(`${address}/${prefix}`)
  }
  return [...normalized]
}

function normalizeChannelAllowlist(input: ChannelAllowlistRule[], label: string): ChannelAllowlistRule[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  return input.map((rule, index) => {
    const chatId = String(rule?.chatId || '').trim()
    const threadId = rule?.threadId === undefined || rule.threadId === null ? undefined : String(rule.threadId).trim()
    const userIds = normalizeOptionalIdentifierList(rule?.userIds, `${label}[${index}].userIds`)
    const adminUserIds = normalizeOptionalIdentifierList(rule?.adminUserIds, `${label}[${index}].adminUserIds`)
    if (!chatId || chatId.length > 256) throw new Error(`${label}[${index}].chatId must be 1-256 characters`)
    if (threadId !== undefined && threadId.length > 256) throw new Error(`${label}[${index}].threadId must be <= 256 characters`)
    const normalized: ChannelAllowlistRule = threadId ? { chatId, threadId } : { chatId }
    if (userIds.length) normalized.userIds = userIds
    if (adminUserIds.length) normalized.adminUserIds = adminUserIds
    return normalized
  })
}

function normalizeOptionalIdentifierList(input: string[] | undefined, label: string): string[] {
  if (input === undefined || input === null) return []
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`)
  const values = [...new Set(input.map(value => String(value || '').trim()).filter(Boolean))]
  for (const value of values) {
    if (value.length > 256) throw new Error(`${label} entries must be <= 256 characters`)
  }
  return values
}

function normalizeProfileRole(role: unknown): AgentProfile['role'] {
  if (role === 'planning') return 'planning'
  return 'execution'
}

function normalizeStageList(value: string[], label: string): string[] {
  const stages = Array.isArray(value) ? value.map(stage => String(stage || '').trim()).filter(Boolean) : []
  const unique = [...new Set(stages)]
  if (unique.length === 0) throw new Error(`${label} must include at least one stage`)
  for (const stage of unique) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(stage)) throw new Error(`${label} contains invalid stage: ${stage}`)
  }
  return unique
}

function normalizeStageProfiles(stageProfiles: Record<string, string>, pipeline: string[], profiles: Record<string, AgentProfile>): Record<string, string> {
  const normalized: Record<string, string> = {}
  for (const [stage, profileName] of Object.entries(stageProfiles)) {
    if (stage !== 'default' && !/^[a-zA-Z0-9_-]{1,64}$/.test(stage)) throw new Error(`scheduler.stageProfiles contains invalid stage: ${stage}`)
    if (!profiles[profileName]) throw new Error(`scheduler.stageProfiles.${stage} references missing profile: ${profileName}`)
    normalized[stage] = profileName
  }
  if (!normalized['default']) normalized['default'] = 'implementer'
  if (!profiles[normalized['default']]) throw new Error(`scheduler.stageProfiles.default references missing profile: ${normalized['default']}`)
  for (const stage of pipeline) {
    if (!normalized[stage]) normalized[stage] = normalized['default']
  }
  return normalized
}

function boundedInteger(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer between ${min} and ${max}`)
  return number
}

function boundedNumber(value: unknown, min: number, max: number, label: string): number {
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label} must be a number between ${min} and ${max}`)
  return number
}

function assertProfileName(name: string): void {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('profile name must be 1-64 letters, numbers, underscores, or dashes')
}

function deepMerge<T extends Record<string, any>>(defaults: T, overrides: T): T {
  const result = { ...defaults }
  for (const key of Object.keys(overrides)) {
    if (overrides[key] && typeof overrides[key] === 'object' && !Array.isArray(overrides[key]) && typeof defaults[key] === 'object') {
      (result as any)[key] = deepMerge(defaults[key], overrides[key])
    } else {
      (result as any)[key] = overrides[key]
    }
  }
  return result
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}


function backupExistingFile(file: string): void {
  if (!fs.existsSync(file)) return
  const backup = `${file}.bak`
  fs.copyFileSync(file, backup)
  try { fs.chmodSync(backup, 0o600) } catch {}
}

function atomicWriteFile(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, content, { mode: 0o600 })
  fs.renameSync(tmp, file)
  try { fs.chmodSync(file, 0o600) } catch {}
}

export function getConfigPath(): string { return configFile() }
export function getConfigDir(): string { return configDir() }
