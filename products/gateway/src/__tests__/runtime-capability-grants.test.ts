import { describe, expect, it } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { agentProfileRevision, agentTeamRevision, type AgentProfile, type AgentTeamConfig, type GatewayConfig } from '../config.js'
import { defaultGatewayEnvironmentConfig, environmentPromptContext, prepareEnvironment, resolveEnvironmentSpec, type EnvironmentSpecInput } from '../environments.js'
import { buildRuntimeIsolationProfile, runtimeIsolationPromptContext } from '../runtime-isolation.js'
import { buildRuntimeCapabilityGrant, runtimeCapabilityGrantPromptContext, summarizeRuntimeCapabilityGrant } from '../runtime-capability-grants.js'

describe('runtime capability grants', () => {
  it('builds redacted executable grants and evaluates least-privilege requests', () => {
    const config = baseConfig()
    const spec = environmentSpec({
      name: 'local-secret-workdir',
      workdir: path.join(os.homedir(), 'opencode-gateway-secret-project'),
      env: { GITHUB_TOKEN: 'secret-token-value' },
      secrets: { allow: ['GITHUB_TOKEN'] },
      network: {
        mode: 'restricted',
        allow: [
          'https://api.github.com/repos/private?token=secret-token-value',
          'ghp_secretuserinfo@example.com:owner/private-repo',
          'ssh://user:password@git.example.test/team/private-repo',
        ],
      },
    })
    const run = prepareEnvironment(spec, { taskId: 'task_runtime_grant', stage: 'implement', now: new Date('2026-06-29T10:00:00.000Z') })
    const hydrated = buildRuntimeCapabilityGrant({
      taskId: 'task_runtime_grant',
      stage: 'implement',
      profileName: 'implementer',
      profile: config.profiles['implementer']!,
      profileRevision: agentProfileRevision(config.profiles['implementer']!),
      config,
      source: 'scheduler.stageProfiles.implement',
      effectivePermission: config.profiles['implementer']!.permission,
      environmentSpec: spec,
      environmentRun: run,
      workdir: path.join(os.homedir(), 'opencode-gateway-secret-project'),
      now: new Date('2026-06-29T10:00:00.000Z'),
      availability: { agents: new Set<string>(), skills: new Set<string>(), mcpServers: new Set<string>(), tools: new Set<string>(), source: 'provided' },
    })

    expect(hydrated).toMatchObject({ status: 'granted', validation: { ok: true }, grants: { agent: 'gateway-implementer' } })
    expect(runtimeCapabilityGrantPromptContext(hydrated)).toContain('Runtime capability grant:')
    expect(summarizeRuntimeCapabilityGrant(hydrated)).toMatchObject({ id: hydrated.id, status: 'granted' })
    const runtimeProfile = buildRuntimeIsolationProfile({
      taskId: 'task_runtime_grant',
      stage: 'implement',
      profileName: 'implementer',
      agentName: 'gateway-implementer',
      environmentSpec: spec,
      environmentRun: run,
      attachmentWorkdir: path.join(os.homedir(), 'opencode-gateway-secret-project'),
      capabilityGrant: hydrated,
    })
    expect(JSON.stringify({ grant: hydrated, runtimeProfile })).not.toContain(os.homedir())
    const serialized = JSON.stringify({
      grant: hydrated,
      environmentPrompt: environmentPromptContext(spec, run),
      runtimeProfile,
      runtimePrompt: runtimeIsolationPromptContext(runtimeProfile),
    })
    for (const raw of [
      'secret-token-value',
      'ghp_secretuserinfo',
      'user:password',
      'owner/private-repo',
      'team/private-repo',
      '/repos/private',
      'evil.example.test',
    ]) expect(serialized).not.toContain(raw)
    expect(serialized).toContain('https://api.github.com')
    expect(serialized).toContain('ssh://git.example.test')
  })

  it('fails closed for unknown grants and expired dispatch windows', () => {
    const config = baseConfig()
    const spec = environmentSpec({ name: 'local', network: { mode: 'disabled' } })
    const run = prepareEnvironment(spec, { taskId: 'task_denied_grant', stage: 'implement', now: new Date('2026-06-29T10:00:00.000Z') })
    const badProfile = {
      ...config.profiles['implementer']!,
      tools: ['missing_worker_tool'],
      budget: { maxRuntimeMs: 1 },
    }
    const deliveryTeam = team({ roles: { implement: 'implementer' }, capabilityRequirements: { implement: ['repo-write'] } })

    const denied = buildRuntimeCapabilityGrant({
      taskId: 'task_denied_grant',
      stage: 'implement',
      profileName: 'implementer',
      profile: badProfile,
      profileRevision: agentProfileRevision(badProfile!),
      config,
      agentTeamName: 'delivery',
      agentTeam: deliveryTeam,
      source: 'agentTeams.delivery.roles.implement',
      effectivePermission: badProfile.permission,
      environmentSpec: spec,
      environmentRun: run,
      issuedAt: new Date('2026-06-29T10:00:00.000Z'),
      now: new Date('2026-06-29T10:00:00.010Z'),
      availability: { agents: new Set<string>(), skills: new Set<string>(), mcpServers: new Set<string>(), tools: new Set<string>(), source: 'provided' },
    })

    expect(denied.status).toBe('denied')
    expect(denied.validation.ok).toBe(false)
    expect(denied.validation.errors.join('\n')).toEqual(expect.stringContaining('LP_TOOL_UNKNOWN'))
    expect(denied.validation.errors.join('\n')).toEqual(expect.stringContaining('grant expired'))
    expect(denied.validation.denied).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'capability', value: 'grant-expired' }),
    ]))
  })
})

function environmentSpec(input: EnvironmentSpecInput) {
  const result = resolveEnvironmentSpec({
    taskEnvironment: input,
    config: defaultGatewayEnvironmentConfig(),
    stage: 'implement',
    workdir: path.join(os.homedir(), 'repo'),
  })
  if (!result.ok) throw new Error(result.reason)
  return result.spec
}

function baseConfig(): GatewayConfig {
  const implementer = profile('gateway-implementer', ['gateway-stage'], 'execution')
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
      stageProfiles: { default: 'implementer', implement: 'implementer' },
      stageConcurrency: {},
      profileConcurrency: {},
      reviewGateIsolation: { enabled: true, stages: ['review', 'verify', 'audit'], deniedTools: [], allowBashEvidenceCommands: true, bashAllowlist: [], forbiddenPathHints: [] },
    },
    profiles: { implementer },
    agentTeams: { default: team({ roles: { default: 'implementer', implement: 'implementer' } }) },
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
