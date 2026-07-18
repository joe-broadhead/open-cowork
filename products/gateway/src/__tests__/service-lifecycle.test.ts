import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildServiceLifecyclePlan, formatServiceLifecyclePlan } from '../service-lifecycle.js'
import type { GatewayConfig } from '../config.js'

const tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('service lifecycle plan', () => {
  it('uses one shared result vocabulary for operator lifecycle operations', () => {
    const root = makeTempRoot()
    const configDir = path.join(root, 'config')
    const stateDir = path.join(root, 'state')
    const homeDir = path.join(root, 'home')
    const plan = buildServiceLifecyclePlan({
      config: config({ opencodeConfigDir: path.join(root, 'opencode') }),
      configDir,
      stateDir,
      homeDir,
      platform: 'darwin',
      now: new Date('2026-06-24T20:00:00.000Z'),
    })

    expect(plan.resultVocabulary).toEqual(['supported', 'read_only', 'dry_run_only', 'manual_required', 'external_approval_required', 'unsupported'])
    expect(plan.operations.map(row => row.id)).toEqual([
      'setup',
      'update',
      'start',
      'stop',
      'restart',
      'status',
      'health',
      'doctor',
      'logs',
      'backup',
      'restore',
      'incident_bundle',
      'cleanup',
      'uninstall',
    ])
    expect(plan.operations.find(row => row.id === 'uninstall')).toMatchObject({
      state: 'manual_required',
      destructive: true,
      dryRun: true,
    })
    expect(formatServiceLifecyclePlan(plan)).toContain('One-command uninstall claimed: no')
  })

  it('keeps OpenCode assets and service-manager files manual instead of agent-safe cleanup targets', () => {
    const root = makeTempRoot()
    const opencodeConfigDir = path.join(root, 'opencode-owned-assets')
    const plan = buildServiceLifecyclePlan({
      config: config({ opencodeConfigDir }),
      configDir: path.join(root, 'config'),
      stateDir: path.join(root, 'state'),
      homeDir: path.join(root, 'home'),
      platform: 'linux',
    })

    expect(plan.cleanupTargets.every(row => row.owner === 'gateway' && row.safeForAgentExecution)).toBe(true)
    expect(plan.uninstallTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: opencodeConfigDir, owner: 'opencode', action: 'manual_remove', safeForAgentExecution: false }),
      expect.objectContaining({ kind: 'service_file', owner: 'service_manager', action: 'manual_remove', safeForAgentExecution: false }),
    ]))
    expect(JSON.stringify(plan)).not.toContain('secret-token')
  })
})

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-service-lifecycle-'))
  tempRoots.push(root)
  return root
}

function config(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    opencodeUrl: 'http://127.0.0.1:4096',
    httpPort: 4097,
    heartbeat: { intervalMs: 1000 },
    channelSync: { enabled: true, intervalMs: 1000, includeUserMessages: false },
    security: {
      httpHost: '127.0.0.1',
      allowNonLocalHttp: false,
      publicWebhookMode: false,
      unsafeAllowNoAuth: false,
      unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false },
      channelAllowlists: { telegram: [], whatsapp: [], discord: [] },
    },
    governance: { enabled: false, action: 'warn', global: {}, roadmaps: {}, tasks: {}, stages: {}, runtime: { maxRunMs: 1, staleRunMs: 1 } },
    humanLoop: {
      enabled: true,
      taskStartApproval: false,
      stageApprovals: [],
      externalSideEffectApproval: true,
      budgetExceptionApproval: true,
      destructiveActionApproval: true,
      credentialUseApproval: true,
      defaultTimeoutMs: 1,
      timeoutAction: 'remind',
      priorityTimeoutMs: { HIGH: 1, MEDIUM: 1, LOW: 1 },
    },
    storage: { backend: 'local_sqlite', postgresCompatiblePreview: { enabled: false, schema: 'public' } },
    environments: { defaults: {}, profiles: {} },
    profiles: {},
    agentTeams: {},
    channels: { telegram: { botToken: 'secret-token' }, whatsapp: {} },
    ...overrides,
  } as GatewayConfig
}
