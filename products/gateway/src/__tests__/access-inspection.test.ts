import { describe, expect, it } from 'vitest'
import { inspectProfileAccess, inspectTeamAccess } from '../access-inspection.js'
import { agentTeamRevision, type AgentProfile, type AgentTeamConfig, type GatewayConfig } from '../config.js'
import { defaultGatewayEnvironmentConfig } from '../environments.js'

describe('access inspection', () => {
  it('normalizes grants and emits stable least-privilege warning codes', () => {
    const config = baseConfig()
    const inspection = inspectProfileAccess('ops-planner', {
      ...profile('gateway-planner', ['gateway-planner'], 'planning'),
      permission: { read: 'allow', edit: 'allow', bash: 'allow', webfetch: 'allow', '*': 'allow', secret: 'allow' },
    }, {
      config,
      availability: { agents: new Set<string>(), skills: new Set<string>(), mcpServers: new Set<string>(), tools: new Set<string>(), source: 'provided' },
      now: new Date('2026-06-15T12:00:00Z'),
    })

    expect(inspection).toMatchObject({
      kind: 'profile',
      name: 'ops-planner',
      status: 'blocked',
      generatedAt: '2026-06-15T12:00:00.000Z',
      grants: expect.objectContaining({
        agents: ['gateway-planner'],
        skills: ['gateway-planner'],
      }),
    })
    expect(inspection.warnings.map(warning => warning.code)).toEqual(expect.arrayContaining([
      'LP_PERMISSION_BROAD_ALLOW',
      'LP_PERMISSION_SECRET_ALLOW',
      'LP_PERMISSION_RISKY_ALLOW',
      'LP_ROLE_GRANT_TOO_BROAD',
      'LP_RISKY_COMBINATION',
    ]))
  })

  it('fails closed for malformed provider/model identifiers before dispatch', () => {
    const config = baseConfig()
    const inspection = inspectProfileAccess('bad-model', {
      ...profile('gateway-implementer', ['gateway-stage'], 'execution'),
      model: { providerID: 'bad provider', modelID: '../model' },
    }, {
      config,
      availability: { agents: new Set<string>(), skills: new Set<string>(), mcpServers: new Set<string>(), tools: new Set<string>(), source: 'provided' },
    })

    expect(inspection.status).toBe('blocked')
    expect(inspection.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LP_MODEL_INVALID', path: 'model.providerID', failClosed: true }),
      expect.objectContaining({ code: 'LP_MODEL_INVALID', path: 'model.modelID', failClosed: true }),
    ]))
  })

  it('fails closed for unknown skills and missing team capability requirements', () => {
    const config = baseConfig()
    config.profiles['unknownSkill'] = {
      ...profile('gateway-implementer', ['warehouse-admin'], 'execution'),
      tools: ['gateway_not_real'],
    }
    config.agentTeams['delivery'] = team({
      roles: { default: 'unknownSkill', implement: 'unknownSkill' },
      capabilityRequirements: { implement: ['repo-write'] },
    })

    const profileInspection = inspectProfileAccess('unknownSkill', config.profiles['unknownSkill'], {
      config,
      availability: { agents: new Set<string>(), skills: new Set<string>(), mcpServers: new Set<string>(), tools: new Set<string>(), source: 'provided' },
    })
    const teamInspection = inspectTeamAccess('delivery', config.agentTeams['delivery'], {
      config,
      availability: { agents: new Set<string>(), skills: new Set<string>(), mcpServers: new Set<string>(), tools: new Set<string>(), source: 'provided' },
    })

    expect(profileInspection.status).toBe('blocked')
    expect(profileInspection.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LP_SKILL_UNKNOWN', failClosed: true }),
      expect.objectContaining({ code: 'LP_TOOL_UNKNOWN', failClosed: true }),
    ]))
    expect(teamInspection.status).toBe('blocked')
    expect(teamInspection.requirements).toEqual(expect.arrayContaining([
      { stage: 'implement', capability: 'repo-write', satisfied: false, profile: 'unknownSkill' },
    ]))
    expect(teamInspection.warnings.map(warning => warning.code)).toContain('LP_REQUIRED_GRANT_MISSING')
  })
})

function baseConfig(): GatewayConfig {
  const implementer = profile('gateway-implementer', ['gateway-stage'], 'execution')
  const verifier = profile('gateway-verifier', ['gateway-stage', 'gateway-review-gate'], 'execution', { edit: 'deny' })
  const defaultTeam = team({ roles: { default: 'implementer', implement: 'implementer', verify: 'verifier' } })
  return {
    opencodeUrl: 'http://127.0.0.1:4096',
    httpPort: 4097,
    heartbeat: { intervalMs: 300000 },
    channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true },
    security: {
      httpHost: '127.0.0.1',
      allowNonLocalHttp: false,
      publicWebhookMode: false,
      unsafeAllowNoAuth: false,
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
    alerts: { profileHealth: { enabled: true, windowDays: 7, minRuns: 10, maxGenuineFailureRate: 0.5 }, stuckTask: { enabled: true, runThreshold: 15 }, delivery: { enabled: false, maxAttempts: 10, targets: [] } },
    storage: {
      backend: 'local_sqlite',
      retention: { runsMaxAgeDays: 90, receiptsMaxAgeDays: 90 },
    },
    environments: defaultGatewayEnvironmentConfig(),
    scheduler: {
      enabled: true,
      intervalMs: 10000,
      maxConcurrent: 3,
      leaseMs: 60 * 60 * 1000,
      retryLimit: 2,
      maxRunsPerTask: 25,
      defaultPipeline: ['implement', 'review', 'verify'],
      stageProfiles: { default: 'implementer', implement: 'implementer', review: 'verifier', verify: 'verifier' },
      stageConcurrency: {},
      profileConcurrency: {},
      reviewGateIsolation: { enabled: true, stages: ['review', 'verify', 'audit'], deniedTools: [], allowBashEvidenceCommands: true, bashAllowlist: [], forbiddenPathHints: [] },
    },
    profiles: { implementer, verifier },
    agentTeams: { default: defaultTeam },
    agentFactory: { blueprintDirs: [] },
    channels: { richMessages: { enabled: true }, telegram: { richMessages: { enabled: true } }, whatsapp: {}, discord: { enabled: false, richMessages: { enabled: true } } },
  }
}

function profile(agent: string, skills: string[], role: AgentProfile['role'], permission: Record<string, string> = {}): AgentProfile {
  return {
    model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
    agent,
    skills,
    mcpServers: ['gateway'],
    tools: ['gateway_task_update'],
    permission: { read: 'allow', gateway_: 'allow', 'gateway_*': 'allow', edit: 'ask', bash: 'ask', ...permission },
    heartbeatMs: 0,
    maxTokens: 80000,
    role,
  }
}

function team(input: Partial<Omit<AgentTeamConfig, 'revision'>> & { roles: Record<string, string> }): AgentTeamConfig {
  const normalized: Omit<AgentTeamConfig, 'revision'> = {
    ...input,
    capabilityRequirements: input.capabilityRequirements || {},
    qualitySpecDefaults: input.qualitySpecDefaults || {},
  }
  return { ...normalized, revision: agentTeamRevision(normalized) }
}
