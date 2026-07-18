import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { agentTeamRevision, clearConfigCacheForTest, deleteProfile, getConfig, getConfigPath, updateConfig, updateSchedulerConfig, writeConfig } from '../config.js'

describe('gateway config', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-config-test-'))

  afterAll(() => { try { fs.rmSync(testDir, { recursive: true, force: true }) } catch {} })

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    clearConfigCacheForTest()
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    delete process.env['OPENCODE_GATEWAY_URL']
    delete process.env['OPENCODE_GATEWAY_HTTP_PORT']
    delete process.env['GATEWAY_HTTP_PORT']
    delete process.env['GATEWAY_HTTP_HOST']
    delete process.env['OPENCODE_GATEWAY_ALLOW_NON_LOCAL_HTTP']
    clearConfigCacheForTest()
  })

  it('fails closed on malformed config instead of falling back to defaults', () => {
    fs.mkdirSync(testDir, { recursive: true })
    fs.writeFileSync(getConfigPath(), '{bad json')
    clearConfigCacheForTest()

    expect(() => getConfig()).toThrow('Gateway config is invalid')
    expect(() => updateSchedulerConfig({ enabled: false })).toThrow('Gateway config is invalid')
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe('{bad json')
  })

  it('writes atomically and preserves a backup of the previous config', () => {
    const config = getConfig()
    writeConfig({ ...config, httpPort: 4100 })
    const first = fs.readFileSync(getConfigPath(), 'utf-8')

    writeConfig({ ...getConfig(), httpPort: 4101 })

    expect(JSON.parse(fs.readFileSync(getConfigPath(), 'utf-8')).httpPort).toBe(4101)
    expect(fs.readFileSync(`${getConfigPath()}.bak`, 'utf-8')).toBe(first)
  })

  it('applies Docker/service environment overrides to normalized config', () => {
    process.env['OPENCODE_GATEWAY_URL'] = 'http://host.docker.internal:4096'
    process.env['GATEWAY_HTTP_PORT'] = '4197'
    process.env['GATEWAY_HTTP_HOST'] = '0.0.0.0'
    process.env['OPENCODE_GATEWAY_ALLOW_NON_LOCAL_HTTP'] = 'true'
    clearConfigCacheForTest()

    expect(getConfig()).toMatchObject({
      opencodeUrl: 'http://host.docker.internal:4096',
      httpPort: 4197,
      security: { httpHost: '0.0.0.0', allowNonLocalHttp: true },
    })
  })

  it('rejects non-plain-decimal HTTP port environment overrides', () => {
    process.env['OPENCODE_GATEWAY_HTTP_PORT'] = '1e3'
    clearConfigCacheForTest()

    expect(() => getConfig()).toThrow('OPENCODE_GATEWAY_HTTP_PORT must be an integer between 1 and 65535')
  })

  it('defaults and bounds the exposed-HTTP security hardening keys', () => {
    const security = getConfig().security
    expect(security.capabilityScopedLoopback).toBe(true)
    expect(security.requireNonMcpDestructiveApproval).toBe(true)
    expect(security.exposedHttp).toMatchObject({
      requireStrongToken: true,
      minTokenLength: 16,
      minTokenEntropyBits: 48,
      trustedProxyCidrs: [],
      rateLimit: { enabled: true, windowMs: 60_000, maxRequests: 120, maxTrackedClients: 4096 },
      authLockout: { enabled: true, maxConsecutiveFailures: 5, lockoutMs: 60_000 },
    })

    const updated = updateConfig({ security: { capabilityScopedLoopback: true, requireNonMcpDestructiveApproval: true, exposedHttp: { minTokenLength: 32, trustedProxyCidrs: ['10.0.0.0/8', '2001:db8::/32'], rateLimit: { maxRequests: 30 } } } } as any)
    expect(updated.security.capabilityScopedLoopback).toBe(true)
    expect(updated.security.requireNonMcpDestructiveApproval).toBe(true)
    expect(updated.security.exposedHttp?.minTokenLength).toBe(32)
    expect(updated.security.exposedHttp?.trustedProxyCidrs).toEqual(['10.0.0.0/8', '2001:db8::/32'])
    expect(updated.security.exposedHttp?.rateLimit.maxRequests).toBe(30)
    // Unspecified nested keys keep their defaults.
    expect(updated.security.exposedHttp?.authLockout.maxConsecutiveFailures).toBe(5)

    expect(() => updateConfig({ security: { exposedHttp: { minTokenLength: 4 } } } as any)).toThrow('security.exposedHttp.minTokenLength')
    expect(() => updateConfig({ security: { exposedHttp: { authLockout: { maxConsecutiveFailures: 0 } } } } as any)).toThrow('security.exposedHttp.authLockout.maxConsecutiveFailures')
    expect(() => updateConfig({ security: { exposedHttp: { trustedProxyCidrs: ['10.0.0.0/99'] } } } as any)).toThrow('security.exposedHttp.trustedProxyCidrs[0]')
  })

  it('validates scheduler bounds and referenced profiles', () => {
    expect(() => updateSchedulerConfig({ maxConcurrent: 0 })).toThrow('scheduler.maxConcurrent')
    expect(() => updateSchedulerConfig({ leaseMs: 999 })).toThrow('scheduler.leaseMs')
    expect(() => updateSchedulerConfig({ stageConcurrency: { implement: 0 } })).toThrow('scheduler.stageConcurrency.implement')
    expect(() => updateSchedulerConfig({ capacity: { teamConcurrency: { delivery: 0 }, roadmapConcurrency: {}, channelConcurrency: {} } } as any)).toThrow('scheduler.capacity.teamConcurrency.delivery')
    expect(() => updateSchedulerConfig({ retryLimit: 11 })).toThrow('scheduler.retryLimit')
    expect(() => updateSchedulerConfig({ maxRunsPerTask: 0 })).toThrow('scheduler.maxRunsPerTask')
    expect(() => updateSchedulerConfig({ maxRunsPerTask: 1001 })).toThrow('scheduler.maxRunsPerTask')
    expect(updateSchedulerConfig({ maxRunsPerTask: 40 }).maxRunsPerTask).toBe(40)
    expect(getConfig().scheduler.maxRunsPerTask).toBe(40)
    expect(() => updateConfig({ alerts: { stuckTask: { runThreshold: 0 } } } as any)).toThrow('alerts.stuckTask.runThreshold')
    expect(() => updateConfig({ alerts: { stuckTask: { runThreshold: 1001 } } } as any)).toThrow('alerts.stuckTask.runThreshold')
    expect(updateConfig({ alerts: { stuckTask: { enabled: true, runThreshold: 20 } } } as any).alerts.stuckTask).toMatchObject({ enabled: true, runThreshold: 20 })
    // #203 cross-check: runThreshold >= maxRunsPerTask would freeze the count at
    // the cap before the alert could warn, so it is clamped to cap-1 at normalize.
    updateSchedulerConfig({ maxRunsPerTask: 10 })
    expect(updateConfig({ alerts: { stuckTask: { enabled: true, runThreshold: 10 } } } as any).alerts.stuckTask.runThreshold).toBe(9)
    expect(updateConfig({ alerts: { stuckTask: { enabled: true, runThreshold: 50 } } } as any).alerts.stuckTask.runThreshold).toBe(9)
    expect(updateConfig({ alerts: { stuckTask: { enabled: true, runThreshold: 4 } } } as any).alerts.stuckTask.runThreshold).toBe(4)
    updateSchedulerConfig({ maxRunsPerTask: 40 })
    expect(() => updateSchedulerConfig({ stageProfiles: { 'bad stage': 'reviewer' } })).toThrow('contains invalid stage')
    expect(() => updateSchedulerConfig({ stageProfiles: { verify: 'missing-profile' } })).toThrow('references missing profile')
    expect(() => updateSchedulerConfig({ reviewGateIsolation: { stages: ['bad stage'] } as any })).toThrow('scheduler.reviewGateIsolation.stages')
    expect(() => updateSchedulerConfig({ reviewGateIsolation: { bashAllowlist: ['git status && rm -rf .'] } as any })).toThrow('shell control characters')
    expect(() => updateSchedulerConfig({ reviewGateIsolation: { bashAllowlist: ['git status\nrm -rf .'] } as any })).toThrow(
      'shell control characters',
    )
    expect(() => updateSchedulerConfig({ reviewGateIsolation: { bashAllowlist: ['git status\rrm -rf .'] } as any })).toThrow(
      'shell control characters',
    )
  })

  it('normalizes explicit alert delivery targets and rejects unsafe duplicates', () => {
    expect(getConfig().alerts.delivery).toEqual({ enabled: false, maxAttempts: 10, targets: [] })
    const updated = updateConfig({
      alerts: { delivery: { enabled: true, maxAttempts: 4, targets: [{ provider: 'discord', chatId: 'ops', threadId: 'incidents', minimumSeverity: 'warning' }] } },
    } as any)
    expect(updated.alerts.delivery).toEqual({
      enabled: true,
      maxAttempts: 4,
      targets: [{ provider: 'discord', chatId: 'ops', threadId: 'incidents', minimumSeverity: 'warning' }],
    })
    expect(() => updateConfig({
      alerts: { delivery: { targets: [
        { provider: 'telegram', chatId: 'ops', minimumSeverity: 'critical' },
        { provider: 'telegram', chatId: 'ops', minimumSeverity: 'warning' },
      ] } },
    } as any)).toThrow(/duplicates an earlier target/)
  })

  it('normalizes advanced scheduler capacity and channel backoff defaults', () => {
    const scheduler = updateSchedulerConfig({
      capacity: {
        teamConcurrency: { delivery: 2 },
        roadmapConcurrency: { roadmap_alpha: 1 },
        channelConcurrency: { telegram: 1 },
      },
    } as any)

    expect(scheduler.capacity).toMatchObject({
      teamConcurrency: { delivery: 2 },
      roadmapConcurrency: { roadmap_alpha: 1 },
      channelConcurrency: { telegram: 1 },
    })
    expect(getConfig().channelSync).toMatchObject({ providerBackoffMs: 60_000, maxDeliveryAttempts: 10 })

    updateConfig({ channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true, providerBackoffMs: 5000, maxDeliveryAttempts: 3 } } as any)
    expect(getConfig().channelSync).toMatchObject({ providerBackoffMs: 5000, maxDeliveryAttempts: 3 })
  })

  it('normalizes review gate isolation policy defaults and overrides', () => {
    const config = getConfig()
    expect(config.scheduler.reviewGateIsolation).toMatchObject({
      enabled: true,
      stages: ['review', 'verify', 'audit'],
      deniedTools: expect.arrayContaining(['edit', 'webfetch', 'websearch', 'task', 'todowrite']),
      allowBashEvidenceCommands: true,
    })
    expect(config.scheduler.reviewGateIsolation.bashAllowlist).toEqual(expect.arrayContaining(['git diff', 'npm run verify']))

    const scheduler = updateSchedulerConfig({
      reviewGateIsolation: {
        stages: ['review'],
        allowBashEvidenceCommands: false,
        bashAllowlist: ['git status', 'git status'],
        forbiddenPathHints: ['private notes'],
      } as any,
    })

    expect(scheduler.reviewGateIsolation).toMatchObject({
      enabled: true,
      stages: ['review'],
      allowBashEvidenceCommands: false,
      bashAllowlist: ['git status'],
      forbiddenPathHints: ['private notes'],
    })
  })

  it('normalizes agent teams with a generated scheduler-backed default', () => {
    let config = getConfig()
    expect(config.agentTeams['default']!.roles).toMatchObject(config.scheduler.stageProfiles)
    expect(config.agentTeams['default']!.revision).toBe(agentTeamRevision(config.agentTeams['default']!))

    updateConfig({
      agentTeams: {
        analytics: {
          description: 'Analytics project team',
          roles: { implement: 'implementer', review: 'reviewer', verify: 'verifier' },
          capabilityRequirements: { implement: ['dbt'], verify: ['warehouse:readonly'] },
          qualitySpecDefaults: { verificationCommands: ['dbt test'] },
        },
      },
    } as any)
    config = getConfig()

    expect(config.agentTeams['analytics']).toMatchObject({
      description: 'Analytics project team',
      roles: { default: 'implementer', implement: 'implementer', review: 'reviewer', verify: 'verifier' },
      capabilityRequirements: { implement: ['dbt'], verify: ['warehouse:readonly'] },
      qualitySpecDefaults: { verificationCommands: ['dbt test'] },
    })
    expect(config.agentTeams['analytics']!.revision).toBe(agentTeamRevision(config.agentTeams['analytics']!))
    expect(() => updateConfig({ agentTeams: { broken: { roles: { implement: 'missing-profile' } } } } as any)).toThrow('references missing profile')
  })

  it('normalizes production profile and team contract fields', () => {
    updateConfig({
      profiles: {
        implementer: {
          ...getConfig().profiles['implementer'],
          description: 'Bounded implementer profile',
          capabilities: ['repo-write', 'artifact/ref'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          budget: { maxTokens: 100000, maxCostUsd: 3.5, maxRuntimeMs: 3600000, retryLimit: 1, humanGate: 'on-risk' },
          outputContract: {
            format: 'stage-result',
            requiredEvidence: ['tests run'],
            requiredDecisions: ['nextStage or taskStatus'],
            artifactRefs: true,
            failureClass: true,
          },
          promotionState: 'evaluated',
        },
      },
      agentTeams: {
        product: {
          version: '1.0.0',
          promotionState: 'draft',
          roles: { implement: 'implementer' },
          capabilityRequirements: { implement: ['repo-write', 'artifact/ref', 'gateway_task_update'] },
        },
      },
    } as any)

    const config = getConfig()
    expect(config.profiles['implementer']).toMatchObject({
      description: 'Bounded implementer profile',
      capabilities: ['repo-write', 'artifact/ref'],
      mcpServers: ['gateway'],
      tools: ['gateway_task_update'],
      budget: { maxTokens: 100000, maxCostUsd: 3.5, maxRuntimeMs: 3600000, retryLimit: 1, humanGate: 'on-risk' },
      outputContract: { format: 'stage-result', artifactRefs: true, failureClass: true },
      promotionState: 'evaluated',
    })
    expect(config.agentTeams['product']).toMatchObject({ version: '1.0.0', promotionState: 'draft' })

    expect(() => updateConfig({ profiles: { implementer: { ...getConfig().profiles['implementer'], promotionState: 'trusted' } } } as any)).toThrow('profile.promotionState')
    expect(() => updateConfig({ profiles: { implementer: { ...getConfig().profiles['implementer'], budget: { retryLimit: 11 } } } } as any)).toThrow('profile.budget.retryLimit')
    expect(() => updateConfig({ profiles: { implementer: { ...getConfig().profiles['implementer'], outputContract: { format: 'yaml' } } } } as any)).toThrow('profile.outputContract.format')
    expect(() => updateConfig({ agentTeams: { product: { roles: { implement: 'implementer' }, promotionState: 'trusted' } } } as any)).toThrow('agentTeams.product.promotionState')
  })

  it('validates security host and channel allowlists', () => {
    expect(() => updateConfig({ security: { httpHost: 'bad host' } } as any)).toThrow('security.httpHost')
    expect(() => updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: '' }], whatsapp: [] } } } as any)).toThrow('security.channelAllowlists.telegram[0].chatId')

    updateConfig({ security: { channelAllowlists: { telegram: [{ chatId: 'chat-1', threadId: 'topic-1' }], whatsapp: [{ chatId: 'wa-fixture-target' }] } } } as any)
    expect(getConfig().security.channelAllowlists.telegram[0]).toEqual({ chatId: 'chat-1', threadId: 'topic-1' })

    updateConfig({ security: { unsafeAllowAllChannelTargets: { telegram: true } } } as any)
    expect(getConfig().security.unsafeAllowAllChannelTargets).toEqual({ telegram: true, whatsapp: false, discord: false })
  })

  it('normalizes channel rich message kill switches', () => {
    expect(getConfig().channels.richMessages.enabled).toBe(true)
    expect(getConfig().channels.telegram.richMessages?.enabled).toBe(true)

    updateConfig({ channels: { richMessages: { enabled: false }, telegram: { richMessages: { enabled: false } } } } as any)

    expect(getConfig().channels.richMessages.enabled).toBe(false)
    expect(getConfig().channels.telegram.richMessages?.enabled).toBe(false)
  })

  it('validates governance budgets and runtime ceilings', () => {
    expect(() => updateConfig({ governance: { action: 'deny' } } as any)).toThrow('governance.action')
    expect(() => updateConfig({ governance: { global: { dailyCostUsd: -1 } } } as any)).toThrow('governance.global.dailyCostUsd')
    expect(() => updateConfig({ governance: { stages: { 'bad stage': { tokenLimit: 1 } } } } as any)).toThrow('governance.stages contains invalid key')

    updateConfig({ governance: { global: { dailyCostUsd: 1.25 }, stages: { implement: { tokenLimit: 1000, action: 'pause' } } } } as any)
    expect(getConfig().governance.global.dailyCostUsd).toBe(1.25)
    expect(getConfig().governance.stages['implement']).toMatchObject({ tokenLimit: 1000, action: 'pause' })
  })

  it('normalizes execution environment registry and profile defaults', () => {
    const config = getConfig()
    expect(config.environments).toMatchObject({ defaultEnvironment: 'local-process', maxRetained: 10, backendMaxConcurrent: {}, environments: { 'local-process': { backend: 'local-process' } } })

    updateConfig({
      environments: {
        defaultEnvironment: 'node-local',
        maxRetained: 2,
        backendMaxConcurrent: { 'remote-crabbox': 1 },
        environments: { 'node-local': { backend: 'local-process', tools: ['node'] } },
      },
      profiles: {
        implementer: { ...getConfig().profiles['implementer'], environment: 'node-local' },
      },
    } as any)

    expect(getConfig().environments.defaultEnvironment).toBe('node-local')
    expect(getConfig().environments.maxRetained).toBe(2)
    expect(getConfig().environments.backendMaxConcurrent).toEqual({ 'remote-crabbox': 1 })
    expect(getConfig().profiles['implementer']!.environment).toBe('node-local')
    expect(() => updateConfig({ environments: { defaultEnvironment: 'missing', environments: {} } } as any)).toThrow('references missing environment')
    expect(() => updateConfig({ environments: { maxRetained: -1 } } as any)).toThrow('environments.maxRetained')
    expect(() => updateConfig({ environments: { backendMaxConcurrent: { bad: 1 } } } as any)).toThrow('environment.backend')
    expect(() => updateConfig({ environments: { backendMaxConcurrent: { custom: 0 } } } as any)).toThrow('environments.backendMaxConcurrent.custom')
  })

  it('keeps storage on the supported local SQLite backend', () => {
    expect(getConfig().storage).toMatchObject({ backend: 'local_sqlite' })
    expect(() => updateConfig({ storage: { backend: 'postgres_compatible_preview' } } as any)).toThrow('storage.backend must be local_sqlite')
  })

  it('validates human loop approval and timeout policy', () => {
    expect(() => updateConfig({ humanLoop: { timeoutAction: 'ignore' } } as any)).toThrow('humanLoop.timeoutAction')
    expect(() => updateConfig({ humanLoop: { stageApprovals: ['bad stage'] } } as any)).toThrow('humanLoop.stageApprovals')
    expect(() => updateConfig({ humanLoop: { defaultTimeoutMs: 999 } } as any)).toThrow('humanLoop.defaultTimeoutMs')

    updateConfig({ humanLoop: { stageApprovals: ['verify'], timeoutAction: 'pause', priorityTimeoutMs: { HIGH: 2000 } } } as any)
    expect(getConfig().humanLoop.stageApprovals).toEqual(['verify'])
    expect(getConfig().humanLoop.timeoutAction).toBe('pause')
    expect(getConfig().humanLoop.priorityTimeoutMs.HIGH).toBe(2000)
  })

  it('ships base Gateway profiles without optional downstream skill dependencies', () => {
    const config = getConfig()
    const allSkills = Object.values(config.profiles).flatMap(profile => profile.skills)

    expect(Object.values(config.profiles).map(profile => profile.agent).sort()).toEqual([
      'gateway-auditor',
      'gateway-coordinator',
      'gateway-implementer',
      'gateway-planner',
      'gateway-reviewer',
      'gateway-supervisor',
      'gateway-verifier',
    ])
    expect([...new Set(allSkills)].sort()).toEqual(['gateway-coordinator', 'gateway-planner', 'gateway-review-gate', 'gateway-stage', 'gateway-supervisor'])
    expect(config.profiles['reviewer']!.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' })
    expect(config.profiles['verifier']!.model).toEqual({ providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' })
    expect(config.profiles['supervisor']).toMatchObject({ model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'xhigh' }, agent: 'gateway-supervisor', skills: ['gateway-supervisor'] })
    expect(allSkills.join(' ')).not.toMatch(/google|github|plaud|tavily|repo-audit|production-spec|implementation-dod|roadmap-execution/)
    expect(Object.values(config.profiles).map(profile => profile.role).sort()).toEqual(['execution', 'execution', 'execution', 'execution', 'planning', 'planning', 'planning'])
    expect(config.security).toMatchObject({ httpHost: '127.0.0.1', allowNonLocalHttp: false, publicWebhookMode: false, unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false } })
    expect(config.governance).toMatchObject({ enabled: true, action: 'block', global: {} })
    expect(config.humanLoop).toMatchObject({ enabled: true, taskStartApproval: false, timeoutAction: 'escalate' })
  })

  it('prevents deleting profiles still referenced by scheduler stages', () => {
    expect(() => deleteProfile('reviewer')).toThrow('references missing profile: reviewer')
    clearConfigCacheForTest()
    expect(getConfig().profiles['reviewer']).toBeDefined()
  })
})
