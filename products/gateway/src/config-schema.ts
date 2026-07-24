/**
 * Zod defense-in-depth schema for the *normalized* Gateway config.
 * Leaf module — no import from config.ts.
 */
import { z } from 'zod'

const zStringRecord = <Schema extends z.ZodTypeAny>(schema: Schema) => z.record(z.string(), schema)

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
  telegram: z.object({
    botToken: zString.optional(),
    richMessages: z.object({ enabled: zBoolean }).optional(),
    /** JOE-994 Phase 2: durable (default) | monorepo provider façade. Env OPEN_COWORK_TELEGRAM_PROTOCOL_STACK overrides. */
    protocolStack: z.enum(['durable', 'monorepo']).optional(),
  }),
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
