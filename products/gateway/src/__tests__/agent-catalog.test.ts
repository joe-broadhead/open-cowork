import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildAgentCatalog, buildLocalReadinessCatalog, listBlueprintCatalogDirs } from '../agent-catalog.js'
import type { BlueprintDefinition } from '../blueprints.js'
import { agentTeamRevision, type AgentProfile, type AgentTeamConfig, type GatewayConfig } from '../config.js'
import { defaultGatewayEnvironmentConfig } from '../environments.js'

describe('agent catalog', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-agent-catalog-test-'))

  beforeEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    delete process.env['TELEGRAM_BOT_TOKEN']
  })

  it('loads profiles, teams, and persisted blueprints with stable ordering and IDs', () => {
    const blueprintDir = path.join(testDir, 'blueprints')
    fs.mkdirSync(blueprintDir, { recursive: true })
    fs.writeFileSync(path.join(blueprintDir, 'zeta.json'), JSON.stringify(validBlueprint('zeta'), null, 2))
    fs.writeFileSync(path.join(blueprintDir, 'alpha.json'), JSON.stringify(validBlueprint('alpha'), null, 2))

    const catalog = buildAgentCatalog({ config: baseConfig(), blueprintDirs: [blueprintDir], now: new Date('2026-06-15T12:00:00Z') })

    expect(catalog.generatedAt).toBe('2026-06-15T12:00:00.000Z')
    expect(catalog.profiles.map(profile => profile.name)).toEqual([...catalog.profiles.map(profile => profile.name)].sort())
    expect(catalog.profiles.find(profile => profile.name === 'catalogued')).toMatchObject({
      id: 'profile:catalogued',
      version: '2026.06',
      lastUpdatedAt: '2026-06-15T10:00:00Z',
      summary: expect.objectContaining({ capabilities: ['catalogue'] }),
    })
    expect(catalog.teams.find(team => team.name === 'catalogued')).toMatchObject({
      id: 'team:catalogued',
      version: '1.0.0',
      lastUpdatedAt: '2026-06-15T11:00:00Z',
      roles: expect.arrayContaining([expect.objectContaining({ stage: 'implement', profile: 'catalogued' })]),
    })
    expect(catalog.blueprints.map(blueprint => blueprint.name)).toEqual(['alpha', 'zeta'])
    expect(catalog.blueprints[0]).toMatchObject({
      id: 'blueprint:alpha@1.0.0',
      status: 'valid',
      profiles: ['alpha'],
      teams: ['alpha'],
    })
  })

  it('reports a missing blueprint library as an empty source state', () => {
    const missing = path.join(testDir, 'missing-blueprints')

    const catalog = buildAgentCatalog({ config: baseConfig(), blueprintDirs: [missing] })

    expect(catalog.blueprints).toEqual([])
    expect(catalog.sources.blueprints).toEqual([{ path: missing, status: 'missing', count: 0 }])
    expect(catalog.errors).toEqual([])
  })

  it('includes the default blueprint library with configured additional directories', () => {
    const previousConfigDir = process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    try {
      const config = { ...baseConfig(), agentFactory: { blueprintDirs: ['custom-blueprints', 'blueprints'] } }

      expect(listBlueprintCatalogDirs(config)).toEqual([
        path.join(testDir, 'blueprints'),
        path.join(testDir, 'custom-blueprints'),
      ])
    } finally {
      if (previousConfigDir === undefined) delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
      else process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = previousConfigDir
    }
  })

  it('keeps invalid blueprint files visible as blocked catalog entries', () => {
    const blueprintDir = path.join(testDir, 'blueprints')
    fs.mkdirSync(blueprintDir, { recursive: true })
    fs.writeFileSync(path.join(blueprintDir, 'broken.json'), '{ not-json')

    const catalog = buildAgentCatalog({ config: baseConfig(), blueprintDirs: [blueprintDir] })

    expect(catalog.totals).toMatchObject({ blueprints: 1, blocked: 1 })
    expect(catalog.errors[0]).toMatchObject({ path: path.join(blueprintDir, 'broken.json') })
    expect(catalog.blueprints[0]).toMatchObject({
      id: 'blueprint:broken@invalid',
      status: 'blocked',
      validation: { errors: [expect.objectContaining({ code: 'invalid_blueprint_file' })] },
    })
  })

  it('keeps allowed blueprint permissions visible when later scopes are stricter', () => {
    const blueprintDir = path.join(testDir, 'blueprints')
    fs.mkdirSync(blueprintDir, { recursive: true })
    const blueprint = validBlueprint('conflict')
    blueprint.profiles!['conflict']!.permission = { read: 'allow', bash: 'allow', edit: 'ask' }
    blueprint.permissions = { runtime: { bash: 'deny', edit: 'deny' } }
    fs.writeFileSync(path.join(blueprintDir, 'conflict.json'), JSON.stringify(blueprint, null, 2))

    const catalog = buildAgentCatalog({ config: baseConfig(), blueprintDirs: [blueprintDir] })

    expect(catalog.blueprints[0]!.summary.permissions.allowed).toEqual(expect.arrayContaining(['bash', 'read']))
    expect(catalog.blueprints[0]!.summary.permissions.risky).toContain('bash')
    expect(catalog.blueprints[0]!.summary.permissions.allow).toBe(2)
  })

  it('validates team catalog capabilities like scheduler stage resolution', () => {
    const config = baseConfig()
    config.profiles['prefix'] = profile('gateway-implementer', ['gateway-stage'], 'execution', { repo_: 'allow' })
    config.profiles['missingDefault'] = profile('gateway-implementer', ['gateway-stage'], 'execution')
    config.agentTeams['prefix'] = team({
      roles: { default: 'prefix', implement: 'prefix' },
      capabilityRequirements: { default: ['repo'], implement: ['gateway-stage'] },
    })
    config.agentTeams['missingDefault'] = team({
      roles: { default: 'missingDefault', implement: 'missingDefault' },
      capabilityRequirements: { default: ['repo'], implement: ['gateway-stage'] },
    })

    const catalog = buildAgentCatalog({ config, blueprintDirs: [] })

    expect(catalog.teams.find(row => row.name === 'prefix')).toMatchObject({ status: 'valid', warnings: [] })
    expect(catalog.teams.find(row => row.name === 'missingDefault')).toMatchObject({
      status: 'blocked',
      inspection: {
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: 'LP_REQUIRED_GRANT_MISSING', failClosed: true }),
        ]),
      },
    })
  })

  it('adds a redacted local readiness catalog for runtime, channels, MCP, and setup probes', () => {
    const catalog = buildAgentCatalog({
      config: baseConfig(),
      blueprintDirs: [],
      now: new Date('2026-06-15T12:00:00Z'),
      localReadiness: {
        connectorRegistry: fakeConnectorRegistry([
          fakeConnector('telegram', 'Telegram', 'credentials_needed', { enabled: true, configured: false }),
          fakeConnector('web', 'OpenCode Web', 'provider_connected', { enabled: true, configured: true }),
        ]),
        opencode: { status: 'pass', summary: 'OpenCode is reachable' },
        heartbeat: { status: 'ok', lastCompletedAt: new Date().toISOString(), enabled: true, running: false, intervalMs: 10000 },
      },
    })

    expect(catalog.localReadiness).toMatchObject({
      mode: 'local_readiness_catalog_v1',
      generatedAt: '2026-06-15T12:00:00.000Z',
      redaction: {
        providerSecrets: 'excluded',
        channelTargetIds: 'redacted_or_hashed',
      },
      releaseClaimBoundary: {
        blockedClaims: expect.arrayContaining(['hosted onboarding', 'marketplace readiness', 'universal channel readiness without live proof']),
      },
    })
    expect(catalog.localReadiness.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'runtime:opencode', status: 'supported', statusCode: 'opencode_reachable' }),
      expect.objectContaining({ id: 'mcp:gateway', status: 'supported', statusCode: 'gateway_mcp_available' }),
    ]))
    const deterministic = buildLocalReadinessCatalog({
      config: baseConfig(),
      generatedAt: '2026-06-15T12:00:00.000Z',
      connectorRegistry: fakeConnectorRegistry([
        fakeConnector('telegram', 'Telegram', 'credentials_needed', { enabled: true, configured: false }),
        fakeConnector('web', 'OpenCode Web', 'provider_connected', { enabled: true, configured: true }),
      ]),
      opencode: { status: 'pass', summary: 'OpenCode is reachable' },
      heartbeat: { status: 'ok', lastCompletedAt: new Date().toISOString(), enabled: true, running: false, intervalMs: 10000 },
    })
    expect(deterministic.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'channel:telegram', status: 'waived', statusCode: 'channel_credentials_needed' }),
      expect.objectContaining({ id: 'setup:provider_capabilities', status: 'partial' }),
    ]))
    const serialized = JSON.stringify(catalog.localReadiness)
    expect(serialized).not.toContain('fixture-secret')
    expect(serialized).not.toContain('chatId:')
  })

  it('distinguishes missing channel tokens, stale heartbeat, and unsupported provider paths without leaking secret values', () => {
    const config = baseConfig()
    config.channels.whatsapp = { setupMode: 'embeddedSignup', embeddedSignup: { enabled: true, appId: 'app-id-only' } } as any
    config.security.channelAllowlists.telegram = [{ chatId: 'redacted-telegram-target' }]
    const catalog = buildLocalReadinessCatalog({
      config,
      connectorRegistry: fakeConnectorRegistry([
        fakeConnector('telegram', 'Telegram', 'credentials_needed', {
          enabled: true,
          configured: false,
          setupPaths: [{ key: 'polling', label: 'Polling', implementationStatus: 'implemented', active: true, configured: true, state: 'credentials_needed' }],
          missingPrerequisites: [{ remediation: 'Set TELEGRAM_BOT_TOKEN or channels.telegram.botToken.' }],
        }),
        fakeConnector('whatsapp', 'WhatsApp', 'blocked', {
          enabled: true,
          configured: true,
          setupPaths: [{ key: 'embedded_signup_provider', label: 'Embedded Signup / provider-managed', implementationStatus: 'scaffolded', active: true, configured: true, state: 'blocked' }],
          diagnostics: [{ code: 'provider_unavailable', severity: 'blocked', summary: 'WhatsApp Embedded Signup/provider-managed setup is scaffolded but not live-enabled.', remediation: 'Use the direct Cloud API path today.' }],
          missingPrerequisites: [{ remediation: 'Use the direct Cloud API path today.' }],
        }),
      ]),
      opencode: { status: 'fail', summary: 'OpenCode is unreachable: ECONNREFUSED fixture-private-value' },
      heartbeat: { status: 'ok', lastCompletedAt: '2026-06-15T00:00:00.000Z', enabled: true, running: false, intervalMs: 10000 },
    })

    expect(catalog.entries.find(entry => entry.id === 'runtime:opencode')).toMatchObject({
      status: 'blocked',
      statusCode: 'opencode_unreachable',
      remediation: expect.stringContaining('Start opencode serve'),
    })
    expect(catalog.entries.find(entry => entry.id === 'setup:daemon_heartbeat')).toMatchObject({
      status: 'partial',
      statusCode: 'heartbeat_stale',
      remediation: expect.stringContaining('Restart or resume'),
    })
    expect(catalog.entries.find(entry => entry.id === 'channel:whatsapp')).toMatchObject({
      status: 'blocked',
      statusCode: 'channel_blocked',
    })
    expect(catalog.entries.find(entry => entry.id === 'setup:channel_credentials')).toMatchObject({
      status: 'blocked',
      statusCode: 'channel_credentials_or_setup_blocked',
      remediation: expect.stringContaining('TELEGRAM_BOT_TOKEN'),
    })
    expect(JSON.stringify(catalog)).not.toContain('fixture-telegram-value')
  })

  it('waives provider capability readiness when no connector has local operator intent', () => {
    const catalog = buildLocalReadinessCatalog({
      config: baseConfig(),
      generatedAt: '2026-06-15T12:00:00.000Z',
      connectorRegistry: fakeConnectorRegistry([
        fakeConnector('telegram', 'Telegram', 'credentials_needed', { enabled: true, configured: false }),
        fakeConnector('whatsapp', 'WhatsApp', 'credentials_needed', { enabled: true, configured: false }),
      ]),
      opencode: { status: 'pass', summary: 'OpenCode is reachable' },
      heartbeat: { status: 'ok', lastCompletedAt: '2026-06-15T12:00:00.000Z', enabled: true, running: false, intervalMs: 10000 },
    })

    expect(catalog.entries.find(entry => entry.id === 'setup:provider_capabilities')).toMatchObject({
      status: 'waived',
      statusCode: 'provider_capabilities_waived',
    })
  })
})

function fakeConnectorRegistry(connectors: any[]) {
  return {
    generatedAt: '2026-06-15T12:00:00.000Z',
    counts: {},
    connectors,
  } as any
}

function fakeConnector(provider: string, displayName: string, state: string, overrides: Record<string, any> = {}) {
  const configured = overrides['configured'] ?? false
  return {
    provider,
    displayName,
    stage: 'production',
    modes: ['local'],
    state,
    stateSummary: state === 'blocked'
      ? 'The connector must not be used until a missing provider, security, trust, or evidence blocker is resolved.'
      : state === 'provider_connected'
        ? 'Provider credentials or install context are present enough to contact the provider.'
        : 'The connector exists but required provider credentials or local config are missing.',
    enabled: overrides['enabled'] ?? true,
    configured,
    trusted: overrides['trusted'] ?? false,
    unsafeAllowAll: false,
    bindingCount: overrides['bindingCount'] ?? 0,
    credentials: overrides['credentials'] || [{ key: `${provider}_credential`, label: `${displayName} credential`, configured, secret: true, sources: configured ? ['config'] : [] }],
    missingPrerequisites: overrides['missingPrerequisites'] || [],
    diagnostics: overrides['diagnostics'] || [],
    setupPaths: overrides['setupPaths'] || [],
    nextActions: [],
    callback: {},
    onboardingFlow: { primaryAction: { summary: `Repair ${displayName}.`, refs: [] } },
    evidenceRefs: configured ? [`config:channels.${provider}`] : [`binding-count:0`],
    redacted: true,
    ...overrides,
  }
}

function baseConfig(): GatewayConfig {
  const implementer = profile('gateway-implementer', ['gateway-stage'], 'execution')
  const verifier = profile('gateway-verifier', ['gateway-stage', 'gateway-review-gate'], 'execution', { edit: 'deny' })
  const catalogued = {
    ...implementer,
    version: '2026.06',
    updatedAt: '2026-06-15T10:00:00Z',
    description: 'Catalogued implementation profile',
    capabilities: ['catalogue'],
  }
  const defaultTeam = team({ roles: { default: 'implementer', implement: 'implementer', verify: 'verifier' } })
  const cataloguedTeam = team({
    version: '1.0.0',
    updatedAt: '2026-06-15T11:00:00Z',
    description: 'Catalogued team',
    roles: { implement: 'catalogued', verify: 'verifier' },
    capabilityRequirements: { implement: ['catalogue'] },
    qualitySpecDefaults: { evidenceRequirements: ['catalog output'] },
  })

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
    profiles: { implementer, verifier, catalogued },
    agentTeams: { default: defaultTeam, catalogued: cataloguedTeam },
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

function validBlueprint(name: string): BlueprintDefinition {
  return {
    name,
    version: '1.0.0',
    metadata: {
      title: `${name} team`,
      description: `Persisted ${name} blueprint`,
      owner: 'platform',
      updatedAt: '2026-06-15T09:00:00Z',
    },
    requiredOpenCode: {
      agents: ['gateway-implementer'],
      skills: ['gateway-stage'],
      mcpServers: ['gateway'],
      tools: ['gateway_task_update'],
    },
    profiles: {
      [name]: {
        model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
        agent: 'gateway-implementer',
        skills: ['gateway-stage'],
        mcpServers: ['gateway'],
        tools: ['gateway_task_update'],
        permission: { read: 'allow', gateway_task_update: 'allow', edit: 'ask', bash: 'ask' },
        heartbeatMs: 0,
        maxTokens: 80000,
        role: 'execution',
        capabilities: [name],
        promotionState: 'evaluated',
      },
    },
    teams: {
      [name]: {
        version: '1.0.0',
        roles: { implement: name, verify: 'verifier' },
        capabilityRequirements: { implement: [name] },
        qualitySpecDefaults: { evidenceRequirements: [`${name} evidence`] },
      },
    },
  }
}
