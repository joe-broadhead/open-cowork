import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { buildDashboardView, renderDashboardDocument } from '../dashboard.js'
import { buildAgentTeamSummary, buildChannelSummary, buildRunThroughput } from '../mission-data.js'
import { buildUsageWindow } from '../opencode-usage.js'
import { clearWorkStateForTest } from '../work-store.js'

describe('dashboard view model', () => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-gateway-dashboard-test-'))

  beforeEach(() => {
    process.env['OPENCODE_GATEWAY_STATE_DIR'] = testDir
    process.env['OPENCODE_GATEWAY_CONFIG_DIR'] = testDir
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
    fs.mkdirSync(testDir, { recursive: true })
    clearWorkStateForTest(path.join(testDir, 'gateway.db'))
  })

  afterEach(() => {
    delete process.env['OPENCODE_GATEWAY_STATE_DIR']
    delete process.env['OPENCODE_GATEWAY_CONFIG_DIR']
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true })
  })

  it('hides archived work and surfaces attention first', () => {
    const view = buildDashboardView({
      sessions: [{ id: 'ses_1', status: 'running' }, { id: 'ses_2', status: 'done' }],
      questions: [{ id: 'q1' }],
      permissions: [],
      roadmaps: [
        { id: 'roadmap_1', title: 'Active roadmap', status: 'active' },
        { id: 'roadmap_2', title: 'Archived roadmap', status: 'archived' },
      ],
      tasks: [
        { id: 'task_1', roadmapId: 'roadmap_1', title: 'Running task', status: 'running', priority: 'HIGH' },
        { id: 'task_2', roadmapId: 'roadmap_1', title: 'Blocked task', status: 'blocked', priority: 'LOW' },
        { id: 'task_3', roadmapId: 'roadmap_2', title: 'Archived task', status: 'archived', priority: 'LOW' },
      ],
      usage: {
        available: true,
        source: 'opencode.db',
        window: buildUsageWindow(new URLSearchParams('range=today'), new Date(2026, 5, 13, 12)),
        totals: { sessions: 2, messages: 4, cost: 0.42, input: 1000, output: 200, reasoning: 50, cacheRead: 300, cacheWrite: 25, cacheHits: 2, tokenBurn: 1575, cacheHitRate: 300 / 1300 },
        byModel: [],
        byAgent: [],
        topSessions: [],
        series: [],
      },
      readiness: { state: 'ready', summary: 'Gateway is ready', checks: [] },
    })

    expect(view.visibleTasks.map(task => task.id)).toEqual(['task_1', 'task_2'])
    expect(view.archivedCount).toBe(1)
    expect(view.activeTasks.map(task => task.id)).toEqual(['task_1'])
    expect(view.attentionTasks.map(task => task.id)).toEqual(['task_2'])
    expect(view.counts.attention).toBe(2)
    expect(view.roadmaps.map(roadmap => roadmap.id)).toEqual(['roadmap_1'])
    expect(view.usage.totals.tokenBurn).toBe(1575)
    expect(view.usage.window.label).toBe('Today')
    expect(view.readiness.state).toBe('ready')
    expect(view.headline).toContain('need attention')
  })

  it('counts execution environments separately from sessions', () => {
    const view = buildDashboardView({
      sessions: [{ id: 'ses_1', status: 'running' }],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      environments: [
        { id: 'env_active', name: 'local-node', backend: 'local-process', status: 'prepared', cleanup: { state: 'pending' }, artifacts: [] },
        { id: 'env_retained', name: 'remote', backend: 'remote-crabbox', status: 'retained', cleanup: { state: 'retained' }, artifacts: ['artifact://log'] },
        { id: 'env_failed', name: 'container', backend: 'local-container', status: 'cleanup_failed', cleanup: { state: 'failed' }, artifacts: [] },
      ],
    })

    expect(view.counts.environments).toBe(1)
    expect(view.counts.retainedEnvironments).toBe(1)
    expect(view.counts.cleanupFailedEnvironments).toBe(1)
    expect(view.activeSessions).toHaveLength(1)
  })

  it('counts unified attention items when present', () => {
    const view = buildDashboardView({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      attention: { items: [{ id: 'completion_1', kind: 'completion_proposal', severity: 'medium', title: 'Completion', summary: 'Ready', action: 'Approve' }], projects: [{ roadmapId: 'roadmap_1', roadmapTitle: 'Project', severity: 'medium', items: [{ id: 'completion_1' }], channels: 1 }] },
    })

    expect(view.counts.attention).toBe(1)
    expect(view.headline).toContain('1 item')
  })

  it('carries supervisor observability into the dashboard view', () => {
    const view = buildDashboardView({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      supervisorObservability: {
        summary: { total: 1, active: 1, due: 1, leased: 0, stale: 0, paused: 0, blocked: 0, completed: 0 },
        supervisors: [{ supervisorId: 'supervisor_1', roadmapId: 'roadmap_1', roadmapTitle: 'Observed', status: 'active', health: 'due' }],
        auditEvents: [{ id: 1, type: 'roadmap.supervisor.result_applied', subjectId: 'roadmap_1', createdAt: '2026-06-13T00:00:00.000Z' }],
      },
    })

    expect(view.supervisorObservability.summary.due).toBe(1)
    expect(view.supervisors).toEqual([expect.objectContaining({ supervisorId: 'supervisor_1', health: 'due' })])
  })

  it('renders the Aura scope shell with Gateway session terminology', () => {
    const html = renderDashboardDocument({
      sessions: [{ id: 'ses_1', title: 'Example session', status: 'running', agent: 'gateway-implementer' }],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      usage: {
        available: true,
        source: 'opencode.db',
        window: buildUsageWindow(new URLSearchParams('range=last7'), new Date(2026, 5, 13, 12)),
        totals: { sessions: 1, messages: 1, cost: 0.1, input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, cacheHits: 0, tokenBurn: 15, cacheHitRate: 0 },
        byModel: [],
        byAgent: [],
        topSessions: [],
        series: [{ date: '2026-06-13', cost: 0.1, tokens: 15, sessions: 1 }],
      },
      readiness: { state: 'ready', summary: 'Gateway is ready', checks: [] },
      serviceHealth: {
        status: 'degraded',
        generatedAt: '2026-06-13T00:00:00.000Z',
        summary: '1 of 8 service components need attention.',
        counts: { ok: 7, degraded: 1, down: 0 },
        attention: [{ id: 'scheduler', label: 'Scheduler', status: 'degraded', summary: 'Scheduler has not completed a heartbeat yet.', remediation: 'Wait for the first heartbeat.' }],
        components: [
          { id: 'daemon', label: 'Daemon', status: 'ok', summary: 'Daemon is running.', remediation: 'No action required.' },
          { id: 'scheduler', label: 'Scheduler', status: 'degraded', summary: 'Scheduler has not completed a heartbeat yet.', remediation: 'Wait for the first heartbeat.' },
        ],
      },
      profiles: { implementer: { agent: 'gateway-implementer', model: { providerID: 'openrouter', modelID: 'test' }, role: 'execution' } },
      scheduler: { enabled: false, maxConcurrent: 3 },
      environments: [{ id: 'env_1', name: 'local-node', backend: 'local-process', status: 'retained', cleanup: { state: 'retained' }, runId: 'run_1', taskTitle: 'Env task', stage: 'verify', artifacts: ['file:/tmp/gateway-demo.log'], metadata: { apiKey: '<redacted>' }, updatedAt: '2026-06-13T00:00:00.000Z' }],
    })

    expect(html).toContain('data-view="overview"')
    expect(html).toContain('data-view="operator"')
    expect(html).toContain('data-view="alpha-health"')
    expect(html).toContain('data-view="usage"')
    expect(html).toContain('data-view="pipeline"')
    expect(html).toContain('data-view="environments"')
    expect(html).toContain('data-view="channels"')
    expect(html).toContain('data-view="health"')
    expect(html).toContain('data-view="release-cockpit"')
    expect(html).toContain('href="#/environments"')
    expect(html).toContain('href="#/operator"')
    expect(html).toContain('href="#/alpha-health"')
    expect(html).toContain('href="#/channels"')
    expect(html).toContain('href="#/release-cockpit"')
    expect(html).toContain('Execution Environments')
    expect(html).toContain('Why Is This Not Running?')
    expect(html).toContain('Scheduler is paused')
    expect(html).toContain('/artifacts?ref=file%3A%2Ftmp%2Fgateway-demo.log')
    expect(html).not.toContain('apiKey')
    expect(html).not.toContain('&lt;redacted&gt;')
    expect(html).toContain('Gateway Sessions')
    expect(html).toContain('Operator Cockpit')
    expect(html).toContain('Service Health')
    expect(html).toContain('Release Claims')
    expect(html).toContain('Local Beta Health')
    expect(html).toContain('next: Wait for the first heartbeat.')
    expect(html).not.toContain('Gateway Workers')
  })

  it('renders the release claims view from the claim registry', () => {
    const html = renderDashboardDocument({
      generatedAt: '2026-06-30T00:30:00.000Z',
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      readiness: { state: 'ready', summary: 'Gateway is ready', checks: [] },
      serviceHealth: {
        status: 'ok',
        generatedAt: '2026-06-30T00:30:00.000Z',
        summary: 'All components healthy.',
        counts: { ok: 1, degraded: 0, down: 0 },
        attention: [],
        components: [{ id: 'daemon', label: 'Daemon', status: 'ok', summary: 'Daemon is running.', remediation: 'No action required.' }],
      },
    })

    expect(html).toContain('data-testid="release-claims"')
    expect(html).toContain('release-claim-public_local_beta')
    expect(html).toContain('release-claim-production')
    expect(html).toContain('release-claim-hosted_team_saas_multi_tenant')
    expect(html).toContain('public local beta for one trusted local operator')
    expect(html).toContain('production certification remains blocked')
    expect(html).not.toContain('production ready')
  })

  it('renders the operator cockpit with beta scope and deferred gates', () => {
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      readiness: { state: 'ready', summary: 'Gateway is ready', checks: [] },
      governance: { status: 'ok', summary: 'Governance ok' },
      operator: {
        generatedAt: '2026-06-20T00:00:00.000Z',
        state: 'ready_for_beta',
        summary: 'Ready for local beta execution on validated surfaces; deferred gates remain explicit.',
        releaseClaim: {
          scope: 'Public local beta readiness for one trusted operator using OpenCode Web/TUI and validated trusted channel surfaces.',
          productionCertified: false,
          notes: ['M23 public release decision supports public local beta only; local production certification remains deferred until elapsed soak evidence and an affirmative production decision complete.', 'Hosted, team, multi-tenant, and remote-worker claims remain deferred to the M24 architecture-readiness tranche.', 'WhatsApp live parity remains deferred until live provider proof is captured.'],
        },
        scheduler: { enabled: true, maxConcurrent: 3, intervalMs: 30000, runningRuns: 1, expiredLeases: 0, availableSlots: 2, leaseOwners: { 'gateway-test': 1 } },
        capacity: {
          generatedAt: '2026-06-20T00:00:00.000Z',
          scheduler: { running: 1, starting: 0, maxConcurrent: 3, availableSlots: 2, pending: 1 },
          dimensions: [{ dimension: 'team', key: 'delivery', used: 1, limit: 1, pending: 2, status: 'full' }],
          providerBackoff: [{ provider: 'telegram', retryAfter: '2026-06-20T00:01:00.000Z', pending: 1, lastError: 'HTTP 429' }],
          humanGatePressure: 0,
        },
        queue: { total: 2, pending: 1, running: 1, done: 0, blocked: 0, paused: 0, cancelled: 0, archived: 0, high: 1, medium: 1, low: 0 },
        readiness: { state: 'ready', summary: 'Gateway is ready', critical: 0, warnings: 0 },
        governance: { status: 'ok', summary: 'Governance ok' },
        channels: {
          ready: ['web', 'tui', 'telegram'],
          needsAttention: [],
          deferred: [
            { gate: 'whatsapp_live_parity', reason: 'Live WhatsApp proof is intentionally deferred for the next phase.' },
            { gate: 'production_soak', reason: 'Local production certification requires separate elapsed soak evidence and an affirmative production decision.' },
          ],
        },
        attention: { gates: 0, questions: 0, permissions: 0, alerts: 0, criticalAlerts: 0, items: [] },
        actions: [
          { action: 'status', command: 'opencode-gateway operator status', description: 'Print this redacted operator report.' },
          { action: 'pause', command: 'opencode-gateway operator pause', description: 'Pause new scheduler dispatch while active sessions continue.' },
        ],
      },
    })

    expect(html).toContain('Operator Cockpit')
    expect(html).toContain('Ready for local beta execution')
    expect(html).toContain('opencode-gateway operator pause')
    expect(html).toContain('whatsapp_live_parity')
    expect(html).toContain('production_soak')
    expect(html).toContain('Production certified: no')
    expect(html).toContain('team delivery capacity')
    expect(html).toContain('telegram provider backoff')
  })

  it('falls back when mission data contains a partial operator report', () => {
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      readiness: { state: 'not_ready', summary: 'Readiness unavailable', checks: [] },
      governance: { status: 'blocked', summary: 'Governance unavailable' },
      operator: { state: 'blocked', summary: 'partial fallback', actions: [] },
    })

    expect(html).toContain('Operator Cockpit')
    expect(html).toContain('Operator report unavailable from mission data.')
    expect(html).toContain('whatsapp_live_parity')
    expect(html).toContain('production_soak')
  })

  it('renders secret lifecycle posture in Mission Control readiness without values', () => {
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      readiness: {
        state: 'degraded',
        summary: 'Secret lifecycle has posture risks',
        checks: [{
          name: 'security_secret_lifecycle',
          status: 'warn',
          severity: 'warning',
          summary: 'Secret lifecycle has 1 posture risk; local secret references are available',
          details: {
            operatorPosture: {
              mode: 'local_and_team_preview_secret_lifecycle',
              rotationHealth: { healthy: 1, due: 1, overdue: 0, blocked: 0, unsupported: 0 },
              revocation: { active: 2, revoked: 0, unsupported: 0 },
              injectionGuardrails: {
                exactReferences: true,
                exactEnvAllowlist: true,
                providerScopeEnforced: true,
                projectScopeRequired: true,
                workerLeaseRequired: true,
                revokedReferencesDenied: true,
              },
              references: [{
                id: 'secretref_telegram_bot_token_safe',
                inputId: 'telegram_bot_token',
                source: 'environment',
                scope: { path: 'project/channel/telegram/bot_token' },
                capability: 'channel:telegram',
                rotation: { health: 'healthy' },
                revocation: { state: 'active' },
              }],
            },
          },
        }],
      },
    })

    expect(html).toContain('Secret posture')
    expect(html).toContain('telegram_bot_token')
    expect(html).toContain('provider scope')
    expect(html).toContain('project/channel/telegram/bot_token')
    expect(html).not.toContain('fixture-telegram-value')
    expect(html).not.toContain('123456:')
  })

  it('renders backend activation posture in Mission Control readiness without connection values', () => {
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      readiness: {
        state: 'ready',
        summary: 'Storage ready',
        checks: [{
          name: 'storage',
          status: 'pass',
          severity: 'info',
          summary: 'Gateway state directory is writable; backend activation is local_sqlite_default',
          details: {
            backend: {
              mode: 'local_sqlite',
              effectivePersistence: 'local_sqlite',
              activation: {
                status: 'local_sqlite_default',
                cutoverReadiness: 'not_selectable',
                rollbackReadiness: 'drill_available_requires_verified_backup',
                supportedCommands: [
                  { id: 'status', command: 'opencode-gateway backend status --json', safeByDefault: true },
                  { id: 'preflight', command: 'opencode-gateway backend preflight --json', safeByDefault: true },
                ],
                blockers: [{ severity: 'warning', code: 'postgres_preview_disabled' }],
              },
            },
          },
        }],
      },
    })

    expect(html).toContain('Backend activation')
    expect(html).toContain('local_sqlite_default')
    expect(html).toContain('postgres_preview_disabled')
    expect(html).not.toContain('preview.invalid')
    expect(html).not.toContain(['postgresql', '://'].join(''))
  })

  it('renders the M27 operations cockpit with blocked, preview, deferred, stale, and safe action states', () => {
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      readiness: {
        state: 'degraded',
        summary: 'M27 state needs attention',
        checks: [
          {
            name: 'storage',
            status: 'pass',
            severity: 'info',
            summary: 'Gateway state directory is writable; backend activation is local_sqlite_default',
            details: {
              backend: {
                mode: 'local_sqlite',
                activation: {
                  status: 'local_sqlite_default',
                  cutoverReadiness: 'not_selectable',
                  rollbackReadiness: 'drill_available_requires_verified_backup',
                  supportedCommands: [{ id: 'preflight', command: 'opencode-gateway backend preflight --json', safeByDefault: true }],
                },
              },
            },
          },
          { name: 'security_authorization_model', status: 'pass', severity: 'info', summary: 'Selected-surface M27 team-preview enforcement only.', details: { releaseStatus: 'm27_selected_surface_team_preview' } },
          { name: 'security_secret_lifecycle', status: 'pass', severity: 'info', summary: 'Secret lifecycle is local-operator managed with value-free secret references.' },
          { name: 'compliance_audit_retention', status: 'pass', severity: 'info', summary: 'Audit retention supports local redacted evidence.' },
          {
            name: 'channel_certification',
            status: 'warn',
            severity: 'warning',
            summary: 'No provider has current live certification; 1 partial, 0 blocked, 1 deferred.',
            details: {
              certifiedProviders: [],
              partialProviders: ['telegram'],
              blockedProviders: [],
              deferredProviders: ['discord'],
              unsupportedClaims: ['universal channel readiness'],
            },
          },
        ],
      },
      sourceDiagnostics: [
        { source: 'opencode_sessions', available: false, summary: 'OpenCode session source unavailable' },
      ],
    })

    expect(html).toContain('Operations Cockpit')
    expect(html).toContain('data-testid="operations-cockpit"')
    expect(html).toContain('OpenCode session source unavailable')
    expect(html).not.toContain('raw-chat-id')
    expect(html).not.toContain('Bearer secret')
  })

  it('renders Connect Channels setup cards with missing credentials and future adapter guidance', () => {
    clearChannelEnvForDashboardTest()
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      projectBindings: [],
      channels: buildChannelSummary({
        channelSync: { enabled: false, intervalMs: 3000, includeUserMessages: false },
        security: { publicWebhookMode: false, unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false }, channelAllowlists: { telegram: [], whatsapp: [], discord: [] } },
        channels: { telegram: {}, whatsapp: {}, discord: { enabled: false } },
      } as any),
    })

    expect(html).toContain('Connect Channels')
    expect(html).toContain('Channel Setup Cockpit')
    expect(html).toContain('data-testid="channel-cockpit-whatsapp"')
    expect(html).toContain('data-testid="connector-whatsapp"')
    expect(html).toContain('credentials_needed')
    expect(html).toContain('Primary Action')
    expect(html).toContain('Guided Actions')
    expect(html).toContain('data-testid="connector-whatsapp-action-connect"')
    expect(html).toContain('data-testid="connector-whatsapp-action-repair"')
    expect(html).toContain('copyable-command')
    expect(html).toContain('missing_credentials')
    expect(html).toContain('opencode-gateway channel setup whatsapp')
    expect(html).toContain('WHATSAPP_ACCESS_TOKEN')
    expect(html).toContain('channels.whatsapp.accessToken')
    expect(html).toContain('secret redacted')
    expect(html).toContain('Meta Cloud API direct setup needs access token')
    expect(html).toContain('data-testid="connector-telegram"')
    expect(html).toContain('Create a bot with BotFather')
    expect(html).toContain('data-testid="connector-discord"')
    expect(html).toContain('Discord alpha adapter is disabled')
    expect(html).toContain('data-testid="connector-future"')
    expect(html).toContain('Connect')
    expect(html).toContain('Verify')
    expect(html).toContain('Trust')
    expect(html).toContain('Bind')
    expect(html).toContain('Monitor')
  })

  it('renders configured Telegram and pending WhatsApp trust without raw provider targets', () => {
    clearChannelEnvForDashboardTest()
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      projectBindings: [{ id: 'project_alpha', alias: 'alpha', provider: 'telegram', chatId: 'private-chat-id', roadmapId: 'roadmap_alpha', sessionId: 'ses_private', notificationMode: 'immediate' }],
      channels: buildChannelSummary({
        channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true },
        security: { publicWebhookMode: true, unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false }, channelAllowlists: { telegram: [{ chatId: 'private-chat-id' }], whatsapp: [], discord: [] } },
        channels: {
          telegram: { botToken: 'fixture-telegram-value' },
          whatsapp: { accessToken: 'fixture-whatsapp-value', phoneNumberId: 'phone-secret-id', verifyToken: 'verify-secret-token', appSecret: 'app-secret-value' },
          discord: { enabled: false },
        },
      } as any, [
        { provider: 'telegram', chatId: 'private-chat-id', sessionId: 'ses_private', mode: 'chat', createdAt: '', updatedAt: '' },
      ]),
    })

    expect(html).toContain('data-testid="channel-cockpit-telegram"')
    expect(html).toContain('trusted_target_pending')
    expect(html).toContain('<div class="v">1</div><div class="l">bindings</div>')
    expect(html).toContain('/evidence/export?sessionId=ses_private')
    expect(html).toContain('/evidence/export?projectId=roadmap_alpha')
    expect(html).not.toContain('/evidence/export?projectId=project_alpha')
    expect(html).toContain('telegram:target-1 (redacted)')
    expect(html).toContain('Trusted target claim is pending')
    expect(html).toContain('opencode-gateway channel claim whatsapp')
    expect(html).not.toContain('planned claim flow')
    expect(html).not.toContain('local session / session ses_private')
    expect(html).not.toContain('private-chat-id')
    expect(html).not.toContain('fixture-telegram-value')
    expect(html).not.toContain('phone-secret-id')
    expect(html).not.toContain('fixture-whatsapp-value')
    expect(html).not.toContain('verify-secret-token')
    expect(html).not.toContain('app-secret-value')
  })

  it('renders alpha health with durable evidence and first-run fallback states', () => {
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [],
      tasks: [],
      backups: [],
      recoveryDrills: [],
      promotionScorecards: [],
      serviceHealth: {
        status: 'degraded',
        generatedAt: '2026-06-15T12:00:00.000Z',
        summary: '1 component needs attention.',
        counts: { ok: 1, degraded: 1, down: 0 },
        attention: [{ id: 'scheduler', label: 'Scheduler', status: 'degraded', summary: 'No heartbeat yet.', remediation: 'Wait for first heartbeat.' }],
        components: [
          { id: 'daemon', label: 'Daemon', status: 'ok', summary: 'Daemon is running.', remediation: 'No action required.' },
          { id: 'scheduler', label: 'Scheduler', status: 'degraded', summary: 'No heartbeat yet.', remediation: 'Wait for first heartbeat.' },
        ],
      },
      heartbeat: { status: 'never', schedulerEnabled: true, enabled: true, running: false, intervalMs: 30000, tickCount: 0, skippedTicks: 0 },
      scheduler: { enabled: true },
      channels: {
        providers: [],
        sync: { active: false, syncEnabled: false, intervalMs: 3000, includeUserMessages: false, deliveriesTracked: 0, pendingInbound: 0 },
        links: [],
      },
    })

    expect(html).toContain('not_proven')
    expect(html).toContain('The dashboard has enough first-run context')
    expect(html).toContain('No Gateway backup metadata found.')
    expect(html).toContain('No recovery drill evidence found.')
    expect(html).toContain('promotion_scorecards')
  })

  it('builds and renders the Mission Control work graph from representative relationships', () => {
    const view = buildDashboardView({
      sessions: [{ id: 'ses_alpha', title: 'Alpha session', status: 'running', agent: 'gateway-implementer', webUrl: 'http://localhost/session/ses_alpha' }],
      roadmaps: [{ id: 'roadmap_alpha', title: 'Alpha Initiative', status: 'active', agentTeam: 'core', updatedAt: '2026-06-13T00:00:00.000Z' }],
      tasks: [{ id: 'task_alpha', roadmapId: 'roadmap_alpha', title: 'Ship alpha', status: 'blocked', priority: 'HIGH', currentRunId: 'run_alpha', readiness: { reason: 'Waiting for approval' } }],
      projectBindings: [{ id: 'project_alpha', alias: 'alpha', roadmapId: 'roadmap_alpha', sessionId: 'ses_alpha', scope: 'telegram', provider: 'telegram', chatId: 'chat-1', threadId: 'thread-1', notificationMode: 'immediate', updatedAt: '2026-06-13T00:00:00.000Z' }],
      channels: buildChannelSummary({
        channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true },
        security: { unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false }, channelAllowlists: { telegram: [{ chatId: 'chat-1', threadId: 'thread-1' }], whatsapp: [] } },
        channels: { telegram: { botToken: 'redacted-token' }, whatsapp: {} },
      } as any, [
        { provider: 'telegram', chatId: 'chat-1', threadId: 'thread-1', sessionId: 'ses_alpha', roadmapId: 'roadmap_alpha', taskId: 'task_alpha', mode: 'chat', createdAt: '', updatedAt: '' },
      ], { active: true, lastSyncAt: '2026-06-13T00:00:00.000Z', deliveriesTracked: 1, pendingInbound: 0 }, []),
      runs: [{ id: 'run_alpha', taskId: 'task_alpha', stage: 'implement', status: 'failed', sessionId: 'ses_alpha', profile: 'implementer', resolvedProfile: 'implementer', resolvedAgent: 'gateway-implementer', agentTeam: 'core', agentTeamVersion: 'rev1', attempt: 1, startedAt: '2026-06-13T00:00:00.000Z', result: { failureClass: 'test_failed' } }],
      supervisorObservability: {
        summary: { total: 1, active: 1, due: 1, leased: 0, stale: 0, paused: 0, blocked: 0, completed: 0 },
        supervisors: [{ supervisorId: 'supervisor_alpha', roadmapId: 'roadmap_alpha', sessionId: 'ses_alpha', roadmapTitle: 'Alpha Initiative', status: 'active', health: 'due', lastResultSummary: 'Review due' }],
        auditEvents: [],
      },
      alerts: [{ id: 'alert_alpha', severity: 'critical', status: 'active', summary: 'Run failed', target: 'run_alpha', nextAction: 'Inspect logs' }],
      completionProposals: [{ id: 'gate_alpha', roadmapId: 'roadmap_alpha', status: 'pending', recommendation: 'Approve completion' }],
    })

    expect(view.workGraph.stats).toMatchObject({ channels: 1, sessions: 1, projects: 1, initiatives: 1, issues: 1, runs: 1, supervisors: 1, gates: 1, alerts: 1 })
    expect(view.workGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'ses_alpha', label: 'Alpha session', source: '/opencode/sessions', href: 'http://localhost/session/ses_alpha' }),
    ]))
    expect(view.workGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'channel:telegram:chat-1:thread-1', to: 'project_alpha', kind: 'routes to project' }),
      expect.objectContaining({ from: 'project_alpha', to: 'ses_alpha', kind: 'binds session' }),
      expect.objectContaining({ from: 'roadmap_alpha', to: 'task_alpha', kind: 'owns issue' }),
      expect.objectContaining({ from: 'task_alpha', to: 'run_alpha', kind: 'has run' }),
      expect.objectContaining({ from: 'run_alpha', to: 'ses_alpha', kind: 'uses session' }),
      expect.objectContaining({ from: 'supervisor_alpha', to: 'roadmap_alpha', kind: 'supervises initiative' }),
      expect.objectContaining({ from: 'alert_alpha', to: 'run_alpha', kind: 'alerts subject' }),
    ]))

    const html = renderDashboardDocument({
      sessions: [{ id: 'ses_alpha', title: 'Alpha session', status: 'running', agent: 'gateway-implementer' }],
      roadmaps: [{ id: 'roadmap_alpha', title: 'Alpha Initiative', status: 'active' }],
      tasks: [{ id: 'task_alpha', roadmapId: 'roadmap_alpha', title: 'Ship alpha', status: 'blocked', priority: 'HIGH', currentRunId: 'run_alpha', readiness: { reason: 'Waiting for approval' } }],
      projectBindings: [{ id: 'project_alpha', alias: 'alpha', roadmapId: 'roadmap_alpha', sessionId: 'ses_alpha', scope: 'telegram', provider: 'telegram', chatId: 'chat-1', threadId: 'thread-1', notificationMode: 'immediate' }],
      channels: view.channels,
      runs: [{ id: 'run_alpha', taskId: 'task_alpha', stage: 'implement', status: 'failed', sessionId: 'ses_alpha', profile: 'implementer', startedAt: '2026-06-13T00:00:00.000Z' }],
      supervisorObservability: { summary: {}, supervisors: [{ supervisorId: 'supervisor_alpha', roadmapId: 'roadmap_alpha', sessionId: 'ses_alpha', roadmapTitle: 'Alpha Initiative', status: 'active', health: 'due' }], auditEvents: [] },
      alerts: [{ id: 'alert_alpha', severity: 'critical', status: 'active', summary: 'Run failed', target: 'run_alpha' }],
    })

    expect(html).toContain('data-view="work-graph"')
    expect(html).toContain('href="#/work-graph"')
    expect(html).toContain('Relationship Edges')
    expect(html).toContain('channel-target:redacted-target')
    expect(html).not.toContain('channel:telegram:chat-1:thread-1')
    expect(html).toContain('Selected Object')
    expect(html).not.toContain('redacted-token')
  })

  it('renders work graph empty and partial source states', () => {
    const view = buildDashboardView({})
    expect(view.workGraph.nodes).toEqual([])
    expect(view.workGraph.edges).toEqual([])
    expect(view.workGraph.sources.find(source => source.name === 'Sessions')).toMatchObject({ available: false, route: '/opencode/sessions' })
    expect(buildDashboardView({ tasks: [], roadmaps: [] }).workGraph.sources.find(source => source.name === 'Projects')).toMatchObject({ available: false, route: '/project-bindings' })
    expect(buildDashboardView({ completionProposals: [], humanGates: [], requestSourceAvailable: false }).workGraph.sources.find(source => source.name === 'OpenCode Requests')).toMatchObject({ available: false, route: '/opencode/requests', count: 0 })
    const failedSources = buildDashboardView({ sessions: [], tasks: [], workGraphSourceAvailable: { sessions: false, tasks: false } }).workGraph.sources
    expect(failedSources.find(source => source.name === 'Sessions')).toMatchObject({ available: false, route: '/opencode/sessions', count: 0 })
    expect(failedSources.find(source => source.name === 'Issues')).toMatchObject({ available: false, route: '/tasks', count: 0 })
    expect(buildDashboardView({ supervisorObservability: { summary: {}, supervisors: [], auditEvents: [] }, workGraphSourceAvailable: { supervisors: false } }).workGraph.sources.find(source => source.name === 'Supervisors')).toMatchObject({ available: false, route: '/roadmap-supervisors', count: 0 })
    const activeOnly = buildDashboardView({ roadmaps: [{ id: 'roadmap_active', title: 'Active Initiative', status: 'active' }] }).workGraph
    expect(activeOnly.nodes.find(node => node.id === 'roadmap_active')).toMatchObject({ severity: 'ok' })
    expect(activeOnly.stats.blocked).toBe(0)

    const html = renderDashboardDocument({})
    expect(html).toContain('No work graph edges yet. Source: `/tasks`, `/project-bindings`, `/runs`, `/roadmap-supervisors`, `/channels/bindings`.')
    expect(html).toContain('Partial data:')
    expect(html).toContain('Sessions unavailable from /opencode/sessions')
    expect(renderDashboardDocument({ tasks: [], roadmaps: [] })).toContain('Projects unavailable from /project-bindings')
  })

  it('renders source diagnostics when mission data sources degrade', () => {
    const view = buildDashboardView({
      sessions: [],
      roadmaps: [],
      tasks: [],
      sourceDiagnostics: [
        { source: 'opencode_sessions', available: false, summary: 'OpenCode session source unavailable' },
        { source: 'work_graph', available: true, summary: 'Gateway durable work graph loaded.' },
      ],
    })

    expect(view.sourceDiagnostics).toEqual([
      { source: 'opencode_sessions', available: false, summary: 'OpenCode session source unavailable' },
      { source: 'work_graph', available: true, summary: 'Gateway durable work graph loaded.' },
    ])

    const html = renderDashboardDocument({
      sessions: [],
      roadmaps: [],
      tasks: [],
      sourceDiagnostics: view.sourceDiagnostics,
    })
    expect(html).toContain('Source Diagnostics')
    expect(html).toContain('opencode_sessions')
    expect(html).toContain('OpenCode session source unavailable')
  })

  it('renders canonical Mission Control source states and next actions', () => {
    const sourceState = {
      checkedAt: '2026-06-23T12:00:00.000Z',
      nowMs: Date.parse('2026-06-23T12:06:00.000Z'),
      freshnessMs: 5 * 60 * 1000,
    }
    const view = buildDashboardView({
      sessions: [{ id: 'ses_stale', title: 'Stale session source', status: 'running' }],
      sourceAvailability: { sessions: sourceState },
    })
    const html = renderDashboardDocument({
      sessions: [{ id: 'ses_stale', title: 'Stale session source', status: 'running' }],
      sourceAvailability: { sessions: sourceState },
    })

    expect(view.windows['sessions']).toMatchObject({
      state: 'stale',
      severity: 'warning',
      nextAction: expect.stringContaining('Refresh Sessions'),
    })
    expect(view.sourceSummary.counts.stale).toBeGreaterThanOrEqual(1)
    expect(html).toContain('data-testid="source-contract-sessions"')
    expect(html).toContain('stale')
    expect(html).toContain('Refresh Sessions')
  })

  it('renders trace correlation and SLO state in Mission Control health', () => {
    const traceCorrelation = {
      generatedAt: '2026-06-21T13:00:00.000Z',
      traceRootId: 'trace_root_demo12345678',
      tasks: [{ taskId: 'task_trace', traceId: 'trace_task_demo12345678', status: 'running', runTraceIds: ['trace_run_demo12345678'] }],
      runs: [{ runId: 'run_trace', traceId: 'trace_run_demo12345678', taskTraceId: 'trace_task_demo12345678', taskId: 'task_trace', stage: 'verify', status: 'running', sessionHash: 'abcdef123456' }],
      events: [],
      channels: [],
      evidence: [],
      alerts: [],
      auditLedger: [{ eventId: 'audit_evt_1', traceId: 'trace_audit_demo12345678', action: 'operator.pause', result: 'ok', retentionClass: 'security_audit', evidenceRefs: ['audit:pause'] }],
    }
    const observabilitySlo = [
      { id: 'scheduler_latency', label: 'Scheduler latency', thresholdMs: 300000, warningMs: 120000, description: 'bounded', status: 'pass', observedMs: 0, summary: 'oldest pending task age 0s', evidence: [] },
      { id: 'dashboard_render', label: 'Dashboard render', thresholdMs: 2000, warningMs: 1000, description: 'bounded', status: 'warn', observedMs: 1200, summary: 'dashboard render time 1s', evidence: [] },
    ]
    const supportOperations = {
      generatedAt: '2026-06-21T13:00:00.000Z',
      status: 'degraded',
      releaseClaim: 'local_preview_support_observability_only',
      currentMode: 'local_public_beta',
      sourceHealth: [{ source: 'slo_budgets', status: 'ready', summary: '2 budgets evaluated.', evidenceRefs: ['slo:scheduler_latency:pass'] }],
      traceCoverage: { scheduler: 1, workers: 1, channels: 0, evidence: 0, auditLedger: 1, alerts: 0 },
      operatorActions: [{ id: 'pause', label: 'Pause dispatch', command: 'opencode-gateway operator pause', auditOperation: 'operator.pause', safeByDefault: true, summary: 'pause' }],
      incidentBundle: { status: 'redacted_local_supported', command: 'opencode-gateway evidence incident out', manifest: 'incident.json', forbiddenContents: ['raw provider payloads'] },
      serviceLevels: [],
      escalation: { pause: 'pause', retry: 'retry', rollback: 'rollback', exportEvidence: 'export' },
      unsupportedClaims: ['hosted SLO/SLA'],
    }
    const view = buildDashboardView({
      sessions: [],
      roadmaps: [],
      tasks: [],
      traceCorrelation,
      observabilitySlo,
      supportOperations,
      workGraphSourceAvailable: { observability: true },
    })
    const html = renderDashboardDocument({
      sessions: [],
      roadmaps: [],
      tasks: [],
      traceCorrelation,
      observabilitySlo,
      supportOperations,
      workGraphSourceAvailable: { observability: true },
      dashboardWindowOptions: { all: { search: 'trace_task_demo12345678' } },
    })

    expect(view.traceCorrelation?.traceRootId).toBe('trace_root_demo12345678')
    expect(view.observabilitySlo[1]!.status).toBe('warn')
    expect(view.sourceContracts.find(row => row.key === 'observability')).toMatchObject({
      available: true,
      matched: expect.any(Number),
      route: '/observability',
    })
    expect(html).toContain('Trace And SLOs')
    expect(html).toContain('trace_root_demo12345678')
    expect(html).toContain('trace_task_demo12345678')
    expect(html).toContain('trace_audit_demo12345678')
    expect(html).toContain('Dashboard render')
    expect(html).toContain('Support operations')
    expect(html).toContain('opencode-gateway operator pause')
    expect(html).toContain('operator.pause')
    expect(html).toContain('warn')

    const degraded = buildDashboardView({ sessions: [], roadmaps: [], tasks: [], workGraphSourceAvailable: { observability: false } })
    expect(degraded.sourceDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'observability', available: false }),
    ]))
  })

  it('surfaces real human gates in the work graph', () => {
    const view = buildDashboardView({
      sessions: [],
      roadmaps: [{ id: 'roadmap_gate', title: 'Gate Initiative', status: 'active' }],
      tasks: [{ id: 'task_gate', roadmapId: 'roadmap_gate', title: 'Needs approval', status: 'paused', priority: 'HIGH' }],
      humanGates: [{ id: 'gate_task_start', type: 'task_start', status: 'pending', taskId: 'task_gate', roadmapId: 'roadmap_gate', sessionId: 'ses_gate', scopeKey: 'task_start:task:task_gate:', createdAt: '2026-06-13T00:00:00.000Z', updatedAt: '2026-06-13T00:00:00.000Z' }],
    })

    expect(view.workGraph.stats.gates).toBe(1)
    expect(view.workGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'gate_task_start', kind: 'gate', status: 'pending', source: '/human-gates' }),
    ]))
    expect(view.workGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'gate_task_start', to: 'task_gate', kind: 'blocks subject' }),
    ]))
  })

  it('links OpenCode questions and permissions through request sessions', () => {
    const view = buildDashboardView({
      sessions: [{ id: 'ses_request', title: 'Request session', status: 'running' }],
      questions: [{ id: 'question_1', sessionID: 'ses_request', questions: [{ header: 'Confirm', question: 'Proceed?' }] }],
      permissions: [{ id: 'permission_1', sessionID: 'ses_request', permission: 'bash', patterns: ['npm test'], metadata: { token: 'redacted' }, always: [] }],
      requestSourceAvailable: true,
    })

    expect(view.workGraph.stats.gates).toBe(2)
    expect(view.workGraph.sources.find(source => source.name === 'OpenCode Requests')).toMatchObject({ available: true, route: '/opencode/requests', count: 2 })
    expect(view.workGraph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'question_1', kind: 'gate', source: '/opencode/requests', alias: 'ses_request' }),
      expect.objectContaining({ id: 'permission_1', kind: 'gate', source: '/opencode/requests', alias: 'ses_request' }),
    ]))
    expect(view.workGraph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'question_1', to: 'ses_request', source: '/opencode/requests', reason: 'OpenCode request sessionID' }),
      expect.objectContaining({ from: 'permission_1', to: 'ses_request', source: '/opencode/requests', reason: 'OpenCode request sessionID' }),
    ]))
    expect(JSON.stringify(view.workGraph)).not.toContain('npm test')
  })

  it('builds bounded run throughput from completed Gateway runs', () => {
    const now = new Date(2026, 5, 13, 12).getTime()
    const series = buildRunThroughput([
      { status: 'passed', completedAt: new Date(2026, 5, 12, 8).toISOString(), costUsd: 0.25 } as any,
      { status: 'failed', completedAt: new Date(2026, 5, 12, 9).toISOString(), costUsd: 0.10 } as any,
      { status: 'passed', completedAt: new Date(2026, 5, 13, 9).toISOString(), costUsd: 0.15 } as any,
    ], { now, days: 3 })

    expect(series.map(point => point.date)).toEqual(['2026-06-11', '2026-06-12', '2026-06-13'])
    expect(series.map(point => point.done)).toEqual([0, 1, 1])
    expect(series[1]!.cost).toBeCloseTo(0.35)
    expect(series[2]!.cost).toBeCloseTo(0.15)
  })

  it('summarizes channels without exposing credentials', () => {
    const summary = buildChannelSummary({
      channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true },
      security: { unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false }, channelAllowlists: { telegram: [{ chatId: 'chat-1' }], whatsapp: [], discord: [{ chatId: 'discord-channel-1', threadId: 'discord-thread-1' }] } },
      channels: { telegram: { botToken: 'fake-token-for-redaction-test' }, whatsapp: {}, discord: { enabled: true, botToken: 'discord-token-for-redaction-test', publicKey: '11'.repeat(32) } },
    } as any, [
      { provider: 'telegram', chatId: 'chat-1', sessionId: 'ses_1', mode: 'chat', createdAt: '', updatedAt: '' },
    ], { active: true, lastSyncAt: '2026-06-13T00:00:00.000Z', deliveriesTracked: 1, pendingInbound: 0 }, [
      { provider: 'telegram', chatId: 'chat-1', roadmapId: 'roadmap_0', sessionId: 'ses_1', alias: 'telegram-alpha', notificationMode: 'immediate' } as any,
      { provider: 'discord', chatId: 'discord-channel-1', threadId: 'discord-thread-1', roadmapId: 'roadmap_1', sessionId: 'ses_discord', alias: 'discord-alpha', notificationMode: 'all' } as any,
    ])

    expect(summary.providers.find(provider => provider.provider === 'telegram')).toMatchObject({ configured: true, enabled: true, health: 'ok', bindings: 1 })
    expect(summary.connectorRegistry.connectors.find(connector => connector.provider === 'telegram')).toMatchObject({ bindingCount: 1 })
    expect(summary.providers.find(provider => provider.provider === 'whatsapp')).toMatchObject({ configured: false, enabled: false, health: 'down' })
    expect(summary.providers.find(provider => provider.provider === 'discord')).toMatchObject({ configured: true, enabled: true, health: 'ok', bindings: 1 })
    expect(summary.sync).toMatchObject({ syncEnabled: true, active: true, deliveriesTracked: 1 })
    expect(JSON.stringify(summary)).not.toContain('fake-token-for-redaction-test')
    expect(JSON.stringify(summary)).not.toContain('discord-token-for-redaction-test')

    const projectOnly = buildChannelSummary({
      channelSync: { enabled: true, intervalMs: 3000, includeUserMessages: true },
      security: { unsafeAllowAllChannelTargets: { telegram: false, whatsapp: false, discord: false }, channelAllowlists: { telegram: [{ chatId: 'project-chat-id' }], whatsapp: [], discord: [] } },
      channels: { telegram: { botToken: 'fake-token-for-redaction-test' }, whatsapp: {}, discord: { enabled: false } },
    } as any, [], { active: true, deliveriesTracked: 0, pendingInbound: 0 }, [
      { id: 'project_only', alias: 'project-only', provider: 'telegram', chatId: 'project-chat-id', roadmapId: 'roadmap_1', sessionId: 'ses_project', notificationMode: 'immediate', createdAt: '', updatedAt: '', scope: 'telegram', quietHours: {} } as any,
    ])
    expect(projectOnly.connectorRegistry.connectors.find(connector => connector.provider === 'telegram')).toMatchObject({ state: 'ready', bindingCount: 1 })
    expect(JSON.stringify(projectOnly)).not.toContain('project-chat-id')
  })

  it('summarizes agent teams and invalid references without profile permissions', () => {
    const summary = buildAgentTeamSummary({
      profiles: {
        analytics: { model: { providerID: 'openai', modelID: 'gpt-5.5' }, agent: 'dbt-analyst', skills: ['dbt'], permission: { 'dbt_*': 'allow' }, heartbeatMs: 0, maxTokens: 100000, role: 'execution' },
      },
      agentTeams: {
        analytics: { description: 'Analytics delivery', roles: { default: 'analytics', implement: 'analytics' }, capabilityRequirements: { implement: ['dbt'] }, qualitySpecDefaults: { evidenceRequirements: ['dbt run evidence'] }, revision: 'teamrev123' },
      },
    } as any, {
      roadmaps: [
        { id: 'roadmap_analytics', title: 'Revenue Analytics', status: 'active', agentTeam: 'analytics' },
        { id: 'roadmap_missing', title: 'Missing Team', status: 'active', agentTeam: 'missing' },
      ],
      tasks: [
        { id: 'task_analytics', roadmapId: 'roadmap_analytics', title: 'Build dbt model', status: 'pending' },
        { id: 'task_missing', roadmapId: 'roadmap_missing', title: 'Broken task', status: 'pending', agentTeam: 'missing' },
      ],
      runs: [
        { id: 'run_analytics', taskId: 'task_analytics', stage: 'implement', status: 'passed', agentTeam: 'analytics', agentTeamVersion: 'teamrev123', profile: 'analytics', resolvedProfile: 'analytics', resolvedAgent: 'dbt-analyst', sessionId: 'ses_analytics', startedAt: '2026-06-13T00:00:00.000Z' },
      ],
    } as any)

    expect(summary.totals).toMatchObject({ teams: 1, referencedTeams: 1, invalidReferences: 2, activeTasks: 1, recentRuns: 1 })
    expect(summary.teams[0]).toMatchObject({ name: 'analytics', revision: 'teamrev123', health: 'ok', references: { roadmaps: 1, tasks: 1, activeTasks: 1, recentRuns: 1 } })
    expect(summary.teams[0]!.roles.find(role => role.stage === 'implement')).toMatchObject({ profile: 'analytics', agent: 'dbt-analyst' })
    expect(summary.invalidReferences.map(ref => ref.kind)).toEqual(['roadmap', 'task'])
    expect(JSON.stringify(summary)).not.toContain('allow')
  })

  it('renders agent team and run attribution in dashboard views', () => {
    const agentTeams = buildAgentTeamSummary({
      profiles: {
        analytics: { model: { providerID: 'openai', modelID: 'gpt-5.5' }, agent: 'dbt-analyst', skills: ['dbt'], permission: { 'dbt_*': 'allow' }, heartbeatMs: 0, maxTokens: 100000, role: 'execution' },
      },
      agentTeams: {
        analytics: { description: 'Analytics delivery', roles: { default: 'analytics' }, capabilityRequirements: {}, qualitySpecDefaults: {}, revision: 'teamrev123' },
      },
    } as any, {
      roadmaps: [{ id: 'roadmap_analytics', title: 'Revenue Analytics', status: 'active', agentTeam: 'analytics' }],
      tasks: [{ id: 'task_analytics', roadmapId: 'roadmap_analytics', title: 'Build dbt model', status: 'running', priority: 'HIGH', pipeline: ['implement'], currentStage: 'implement' }],
      runs: [{ id: 'run_analytics', taskId: 'task_analytics', stage: 'implement', status: 'passed', agentTeam: 'analytics', profile: 'analytics', resolvedProfile: 'analytics', resolvedAgent: 'dbt-analyst', sessionId: 'ses_analytics', startedAt: '2026-06-13T00:00:00.000Z', environment: { name: 'local-node', backend: 'local-process', preflight: { ok: true } } }],
    } as any)
    const html = renderDashboardDocument({
      sessions: [],
      questions: [],
      permissions: [],
      roadmaps: [{ id: 'roadmap_analytics', title: 'Revenue Analytics', status: 'active', agentTeam: 'analytics' }],
      tasks: [{ id: 'task_analytics', roadmapId: 'roadmap_analytics', title: 'Build dbt model', status: 'running', priority: 'HIGH', pipeline: ['implement'], currentStage: 'implement' }],
      runs: [{ id: 'run_analytics', taskId: 'task_analytics', stage: 'implement', status: 'passed', agentTeam: 'analytics', profile: 'analytics', resolvedProfile: 'analytics', resolvedAgent: 'dbt-analyst', sessionId: 'ses_analytics', environment: { name: 'local-node', backend: 'local-process', preflight: { ok: true } } }],
      agentTeams,
      profiles: { analytics: { agent: 'dbt-analyst', model: { providerID: 'openai', modelID: 'gpt-5.5' }, role: 'execution' } },
    })

    expect(html).toContain('Agent Teams')
    expect(html).toContain('Recent Run Attribution')
    expect(html).toContain('team analytics inherited')
    expect(html).toContain('local-node:local-process')
    expect(html).toContain('analytics - Analytics delivery')
    expect(html).toContain('dbt-analyst')
    expect(html).not.toContain('dbt_*')
  })

  it('builds Agent Factory profile, team, blueprint gate, and promotion summaries', () => {
    const scorecards = [
      {
        id: 'scorecard_arena_safe',
        subjectKind: 'profile',
        subjectName: 'safe-builder',
        subjectRevision: 'rev_safe',
        sourceKind: 'arena',
        sourceId: 'arena.fixture.seeded-defect',
        sourceVersion: '1.0.0',
        metrics: [{ id: 'arena.score', score: 8, maxScore: 8, passed: true }],
        thresholds: [{ id: 'arena.pass_threshold', metric: 'arena.score', actualScore: 1, actualPercentage: 1, passed: true }],
        evidence: ['arena:arena.fixture.seeded-defect@1.0.0', 'file:/tmp/arena-safe.json'],
        conclusion: 'passed',
        recommendation: 'promote',
        status: 'evaluated',
        createdAt: '2026-06-15T10:00:00.000Z',
        updatedAt: '2026-06-15T10:00:00.000Z',
      },
      {
        id: 'scorecard_arena_blocked',
        subjectKind: 'profile',
        subjectName: 'overpowered',
        subjectRevision: 'rev_blocked',
        sourceKind: 'arena',
        sourceId: 'arena.fixture.seeded-defect',
        sourceVersion: '1.0.0',
        metrics: [
          { id: 'arena.score', score: 2, maxScore: 8, passed: false, diagnostic: 'low score' },
          { id: 'tools.tool.allowed:bash', score: 0, maxScore: 1, passed: false, diagnostic: 'bash was not allowed' },
        ],
        thresholds: [{ id: 'arena.pass_threshold', metric: 'arena.score', actualScore: 0.25, actualPercentage: 0.25, passed: false }],
        evidence: ['arena:arena.fixture.seeded-defect@1.0.0', 'file:/tmp/arena-blocked.log'],
        conclusion: 'failed',
        recommendation: 'block',
        status: 'blocked',
        createdAt: '2026-06-15T11:00:00.000Z',
        updatedAt: '2026-06-15T11:00:00.000Z',
      },
    ]
    const view = buildDashboardView({
      profiles: {
        'safe-builder': {
          model: { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          capabilities: ['repo-write'],
          permission: { read: 'allow', grep: 'allow', edit: 'ask', bash: 'deny', gateway_task_update: 'allow' },
          heartbeatMs: 0,
          maxTokens: 100000,
          role: 'execution',
          environment: 'local-process',
          budget: { maxTokens: 100000, maxCostUsd: 0.25, retryLimit: 1, humanGate: 'on-risk' },
          outputContract: { format: 'stage-result' },
        },
        overpowered: {
          model: { providerID: 'openai', modelID: 'gpt-5.5' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          permission: { '': 'allow', bash: 'allow', edit: 'allow', read: 'allow' },
          heartbeatMs: 0,
          maxTokens: 250000,
          role: 'execution',
        },
      },
      agentTeams: {
        totals: { teams: 1, referencedTeams: 1, invalidReferences: 1, activeTasks: 1, recentRuns: 1 },
        teams: [{
          name: 'delivery',
          description: 'Delivery team',
          revision: 'teamrev123',
          promotionState: 'deprecated',
          health: 'warning',
          warnings: ['implement profile overpowered lacks gateway'],
          roles: [{ stage: 'implement', profile: 'overpowered', agent: 'gateway-implementer', model: 'openai/gpt-5.5', role: 'execution' }],
          capabilityRequirements: [{ stage: 'implement', capabilities: ['gateway'] }],
          qualitySpecDefaultKeys: ['evidenceRequirements'],
          references: { roadmaps: 1, tasks: 1, activeTasks: 1, recentRuns: 1 },
        }],
        invalidReferences: [{ kind: 'task', id: 'task_missing', title: 'Missing', agentTeam: 'missing', reason: 'agent team is not configured' }],
        recentRuns: [],
      },
      humanGates: [{ id: 'gate_blueprint', type: 'manual', status: 'pending', scopeKey: 'blueprint:apply:warehouse:1.0.0:abc123', reason: 'Approve blueprint apply: warehouse@1.0.0', requestedAt: '2026-06-15T12:00:00.000Z' }],
      agentCatalog: {
        blueprints: [{
          id: 'blueprint:warehouse@1.0.0',
          name: 'warehouse',
          version: '1.0.0',
          revision: 'bp123',
          title: 'Warehouse team',
          description: 'Persisted warehouse blueprint',
          status: 'valid',
          source: { path: '/tmp/blueprints/warehouse.json' },
          lastUpdatedAt: '2026-06-15T09:00:00.000Z',
          profiles: ['warehouse'],
          teams: ['warehouse'],
          summary: { skills: ['gateway-stage'], mcpServers: ['gateway'], tools: ['gateway_task_update'], permissions: { allow: 2 } },
          validation: { errors: [], warnings: [] },
        }],
        sources: { blueprints: [{ path: '/tmp/blueprints', status: 'ok', count: 1 }] },
      },
      promotionScorecards: scorecards,
      runs: [
        { id: 'run_safe', stage: 'implement', status: 'passed', resolvedProfile: 'safe-builder', resolvedAgent: 'gateway-implementer', agentTeam: 'delivery' },
        { id: 'run_blocked', stage: 'implement', status: 'failed', resolvedProfile: 'overpowered', resolvedAgent: 'gateway-implementer', agentTeam: 'delivery' },
      ],
    })

    expect(view.agentFactory.totals).toMatchObject({ profiles: 2, teams: 1, blueprints: 1, blockedProfiles: 1, deprecatedProfiles: 0, blockedTeams: 1, blueprintGates: 1, scorecards: 2 })
    expect(view.agentFactory.profiles.find(profile => profile.name === 'overpowered')).toMatchObject({
      validation: 'blocked',
      promotion: { state: 'blocked', scorecardId: 'scorecard_arena_blocked' },
    })
    expect(view.agentFactory.profiles.find(profile => profile.name === 'overpowered')?.warnings.join(' ')).toContain('risky allow grants')
    expect(view.agentFactory.profiles.find(profile => profile.name === 'safe-builder')).toMatchObject({ environment: 'local-process', outputContract: 'stage-result' })
    expect(view.agentFactory.teams[0]).toMatchObject({ name: 'delivery', validation: 'blocked', promotion: { state: 'deprecated' } })
    expect(view.arena.totals).toMatchObject({ runs: 2, passed: 1, failed: 1, artifacts: 2, comparisons: 1 })
    expect(view.arena.comparisons[0]!.rows.map(row => row.subject)).toEqual(['profile:safe-builder', 'profile:overpowered'])
  })

  it('uses catalog team validation for Agent Factory team status', () => {
    const view = buildDashboardView({
      profiles: {
        capable: {
          model: { providerID: 'openai', modelID: 'gpt-5.5' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          capabilities: ['catalogue'],
          permission: { read: 'allow', gateway_: 'allow' },
          heartbeatMs: 0,
          maxTokens: 100000,
          role: 'execution',
        },
      },
      agentTeams: {
        totals: { teams: 1, referencedTeams: 0, invalidReferences: 0, activeTasks: 0, recentRuns: 0 },
        teams: [{
          name: 'catalogue',
          description: 'Catalogue team',
          revision: 'teamrev456',
          promotionState: 'draft',
          health: 'warning',
          warnings: ['implement profile capable lacks catalogue'],
          roles: [{ stage: 'implement', profile: 'capable', agent: 'gateway-implementer', model: 'openai/gpt-5.5', role: 'execution' }],
          capabilityRequirements: [{ stage: 'implement', capabilities: ['catalogue', 'gateway_task_update', 'gateway'] }],
          qualitySpecDefaultKeys: [],
          references: { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 },
        }],
        invalidReferences: [],
        recentRuns: [],
      },
      agentCatalog: {
        teams: [{
          name: 'catalogue',
          version: '1.0.0',
          status: 'valid',
          warnings: [],
          lastUpdatedAt: '2026-06-15T09:30:00.000Z',
        }],
        blueprints: [],
        sources: { blueprints: [] },
      },
      humanGates: [],
      promotionScorecards: [],
      promotionDecisions: [],
      runs: [],
    })

    expect(view.agentFactory.teams[0]).toMatchObject({ name: 'catalogue', validation: 'valid', warnings: [] })
  })

  it('renders Agent Factory and Arena routes with filters, scorecards, failures, and blueprint actions', () => {
    const html = renderDashboardDocument({
      profiles: {
        'safe-builder': {
          model: { providerID: 'openai', modelID: 'gpt-5.5' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          mcpServers: ['gateway'],
          tools: ['gateway_task_update'],
          permission: { read: 'allow', grep: 'allow', bash: 'deny', gateway_task_update: 'allow' },
          heartbeatMs: 0,
          maxTokens: 100000,
          role: 'execution',
          environment: 'local-process',
          budget: { maxTokens: 100000, maxCostUsd: 0.25 },
          outputContract: { format: 'stage-result' },
        },
        overpowered: {
          model: { providerID: 'openai', modelID: 'gpt-5.5' },
          agent: 'gateway-implementer',
          skills: ['gateway-stage'],
          permission: { '': 'allow', bash: 'allow', edit: 'allow', read: 'allow' },
          heartbeatMs: 0,
          maxTokens: 250000,
          role: 'execution',
        },
      },
      agentTeams: {
        totals: { teams: 1, referencedTeams: 1, invalidReferences: 0, activeTasks: 0, recentRuns: 0 },
        teams: [{
          name: 'delivery',
          description: 'Delivery team',
          revision: 'teamrev123',
          promotionState: 'promoted',
          health: 'ok',
          warnings: [],
          roles: [{ stage: 'implement', profile: 'safe-builder', agent: 'gateway-implementer', model: 'openai/gpt-5.5', role: 'execution' }],
          capabilityRequirements: [{ stage: 'implement', capabilities: ['gateway_task_update'] }],
          qualitySpecDefaultKeys: ['evidenceRequirements'],
          references: { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 },
        }],
        invalidReferences: [],
        recentRuns: [],
      },
      humanGates: [{ id: 'gate_blueprint', status: 'pending', scopeKey: 'blueprint:apply:warehouse:1.0.0:abc123', reason: 'Approve blueprint apply: warehouse@1.0.0', requestedAt: '2026-06-15T12:00:00.000Z' }],
      agentCatalog: {
        profiles: [{ name: 'safe-builder', version: '1.0.0', revision: 'rev_safe', lastUpdatedAt: '2026-06-15T09:00:00.000Z' }],
        teams: [{ name: 'delivery', version: '1.2.0', lastUpdatedAt: '2026-06-15T09:30:00.000Z' }],
        blueprints: [{
          id: 'blueprint:warehouse@1.0.0',
          name: 'warehouse',
          version: '1.0.0',
          revision: 'bp123',
          title: 'Warehouse team',
          description: 'Persisted warehouse blueprint',
          status: 'valid',
          source: { path: '/tmp/blueprints/warehouse.json' },
          lastUpdatedAt: '2026-06-15T09:00:00.000Z',
          profiles: ['warehouse'],
          teams: ['warehouse'],
          summary: { skills: ['gateway-stage'], mcpServers: ['gateway'], tools: ['gateway_task_update'], permissions: { allow: 2 } },
          validation: { errors: [], warnings: [] },
        }],
        sources: { blueprints: [{ path: '/tmp/blueprints', status: 'ok', count: 1 }] },
      },
      promotionScorecards: [
        {
          id: 'scorecard_arena_safe',
          subjectKind: 'profile',
          subjectName: 'safe-builder',
          subjectRevision: 'rev_safe',
          sourceKind: 'arena',
          sourceId: 'arena.fixture.seeded-defect',
          sourceVersion: '1.0.0',
          metrics: [{ id: 'arena.score', score: 8, maxScore: 8, passed: true }],
          thresholds: [],
          evidence: ['file:/tmp/arena-safe.json'],
          conclusion: 'passed',
          recommendation: 'promote',
          status: 'evaluated',
          createdAt: '2026-06-15T10:00:00.000Z',
          updatedAt: '2026-06-15T10:00:00.000Z',
        },
        {
          id: 'scorecard_arena_blocked',
          subjectKind: 'profile',
          subjectName: 'overpowered',
          subjectRevision: 'rev_blocked',
          sourceKind: 'arena',
          sourceId: 'arena.fixture.seeded-defect',
          sourceVersion: '1.0.0',
          metrics: [
            { id: 'arena.score', score: 2, maxScore: 8, passed: false },
            { id: 'tools.tool.allowed:bash', score: 0, maxScore: 1, passed: false },
          ],
          thresholds: [],
          evidence: ['file:/tmp/arena-blocked.log'],
          conclusion: 'failed',
          recommendation: 'block',
          status: 'blocked',
          createdAt: '2026-06-15T11:00:00.000Z',
          updatedAt: '2026-06-15T11:00:00.000Z',
        },
      ],
      runs: [{ id: 'run_blocked', stage: 'implement', status: 'failed', profile: 'overpowered', resolvedProfile: 'overpowered', resolvedAgent: 'gateway-implementer', agentTeam: 'delivery' }],
    })

    expect(html).toContain('data-view="agent-factory"')
    expect(html).toContain('data-view="arena"')
    expect(html).toContain('href="#/agent-factory"')
    expect(html).toContain('href="#/arena"')
    expect(html).toContain('data-filter-group="profiles"')
    expect(html).toContain('data-filter-button="blocked"')
    expect(html).toContain('data-filter-row="arena"')
    expect(html).toContain('Profile Contracts')
    expect(html).toContain('Blueprint Preview And Apply')
    expect(html).toContain('Warehouse team')
    expect(html).toContain('version 1.2.0')
    expect(html).toContain('Approve blueprint apply: warehouse@1.0.0')
    expect(html).toContain('arena.fixture.seeded-defect@1.0.0')
    expect(html).toContain('tools.tool.allowed:bash')
    expect(html).toContain('/artifacts?ref=file%3A%2Ftmp%2Farena-blocked.log')
    expect(html).toContain('Comparison Summaries')
    expect(html).toContain('overpowered')
    expect(html).not.toContain('secret-token')
  })

  it('maps Arena scorecards and promotion decisions into run details and stable promotion history', () => {
    const scorecards = [
      {
        id: 'scorecard_profile_safe',
        subjectKind: 'profile',
        subjectName: 'safe-builder',
        subjectRevision: 'rev_safe',
        sourceKind: 'arena',
        sourceId: 'arena.fixture.seeded-defect',
        sourceVersion: '1.0.0',
        metrics: [{ id: 'arena.score', score: 8, maxScore: 8, passed: true }],
        thresholds: [{ id: 'arena.pass_threshold', metric: 'arena.score', actualScore: 1, actualPercentage: 1, passed: true }],
        evidence: ['arena:arena.fixture.seeded-defect@1.0.0', 'file:/tmp/arena-safe.json'],
        conclusion: 'safe-builder passed all seeded-defect checks',
        recommendation: 'promote',
        status: 'evaluated',
        regression: { status: 'warning', baselineScorecardId: 'scorecard_profile_previous', metric: 'arena.score', baselinePercentage: 1, currentPercentage: 0.93, delta: 0.07, warnThreshold: 0.05, blockThreshold: 0.15, message: 'Regression guardrail warning' },
        createdAt: '2026-06-15T10:00:00.000Z',
        updatedAt: '2026-06-15T10:00:00.000Z',
      },
      {
        id: 'scorecard_team_delivery',
        subjectKind: 'team',
        subjectName: 'delivery',
        subjectRevision: 'teamrev123',
        sourceKind: 'eval',
        sourceId: 'suite.delivery',
        sourceVersion: '2',
        metrics: [{ id: 'quality', score: 0.4, maxScore: 1, passed: false, diagnostic: 'quality below threshold' }],
        thresholds: [{ id: 'quality.min', metric: 'quality', actualScore: 0.4, actualPercentage: 0.4, passed: false }],
        evidence: ['file:/tmp/delivery-eval.log'],
        conclusion: 'delivery team is blocked by the quality gate',
        recommendation: 'block',
        status: 'blocked',
        createdAt: '2026-06-15T09:00:00.000Z',
        updatedAt: '2026-06-15T09:00:00.000Z',
      },
    ]
    const decisions = [
      {
        id: 'promotion_safe',
        subjectKind: 'profile',
        subjectName: 'safe-builder',
        subjectRevision: 'rev_safe',
        action: 'promote',
        fromStatus: 'evaluated',
        toStatus: 'promoted',
        scorecardId: 'scorecard_profile_safe',
        gateId: 'gate_safe',
        status: 'applied',
        actor: 'operator',
        source: 'mission-control',
        createdAt: '2026-06-15T11:00:00.000Z',
        updatedAt: '2026-06-15T11:00:00.000Z',
      },
      {
        id: 'promotion_delivery_rollback',
        subjectKind: 'team',
        subjectName: 'delivery',
        subjectRevision: 'teamrev123',
        action: 'rollback',
        fromStatus: 'blocked',
        toStatus: 'promoted',
        scorecardId: 'scorecard_team_previous',
        gateId: 'gate_delivery_rollback',
        status: 'applied',
        actor: 'operator',
        source: 'mission-control',
        metadata: { rollback: { eligible: true, status: 'eligible', baselineScorecardId: 'scorecard_team_previous', baselineDecisionId: 'promotion_delivery_previous', targetStatus: 'promoted', reason: 'rollback can restore promoted baseline scorecard_team_previous' } },
        createdAt: '2026-06-15T13:00:00.000Z',
        updatedAt: '2026-06-15T13:00:00.000Z',
      },
      {
        id: 'promotion_delivery_block',
        subjectKind: 'team',
        subjectName: 'delivery',
        subjectRevision: 'teamrev123',
        action: 'block',
        fromStatus: 'evaluated',
        toStatus: 'blocked',
        scorecardId: 'scorecard_team_delivery',
        gateId: 'gate_delivery',
        status: 'applied',
        actor: 'reviewer',
        source: 'quality-gate',
        createdAt: '2026-06-15T12:00:00.000Z',
        updatedAt: '2026-06-15T12:00:00.000Z',
      },
    ]

    const view = buildDashboardView({
      profiles: {
        'safe-builder': { model: { providerID: 'openai', modelID: 'gpt-5.5' }, agent: 'gateway-implementer', skills: ['gateway-stage'], permission: { read: 'allow' }, heartbeatMs: 0, maxTokens: 100000, role: 'execution' },
      },
      agentTeams: {
        totals: { teams: 1, referencedTeams: 0, invalidReferences: 0, activeTasks: 0, recentRuns: 0 },
        teams: [{ name: 'delivery', revision: 'teamrev123', health: 'ok', warnings: [], roles: [], capabilityRequirements: [], qualitySpecDefaultKeys: [], references: { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 } }],
        invalidReferences: [],
        recentRuns: [],
      },
      promotionEvidenceSourceAvailable: true,
      promotionScorecards: scorecards,
      promotionDecisions: decisions,
    })

    expect(view.arena.source).toMatchObject({ available: true, partial: false, scorecards: 2, decisions: 3 })
    expect(view.arena.runs.map(run => run.id)).toEqual(['scorecard_profile_safe', 'scorecard_team_delivery'])
    expect(view.arena.runs[0]).toMatchObject({
      candidateLabel: 'profile:safe-builder',
      candidateHref: '#/agent-factory',
      inputLabel: 'arena:arena.fixture.seeded-defect@1.0.0',
      promotionOutcome: 'promote applied -> promoted',
      regressionLabel: 'regression: warning (7 pp)',
      gateResult: 'applied',
    })
    expect(view.arena.runs[1]!.failedMetrics.map(metric => metric.id)).toEqual(['quality'])
    expect(view.arena.promotionHistory.map(entry => entry.id)).toEqual([
      'decision:promotion_delivery_rollback',
      'decision:promotion_delivery_block',
      'decision:promotion_safe',
      'scorecard:scorecard_profile_safe',
      'scorecard:scorecard_team_delivery',
    ])
    expect(view.arena.promotionHistory[0]).toMatchObject({ subjectLabel: 'team:delivery', rollbackEligibility: 'applied', event: 'rollback blocked -> promoted' })

    const html = renderDashboardDocument({
      profiles: { 'safe-builder': { model: { providerID: 'openai', modelID: 'gpt-5.5' }, agent: 'gateway-implementer', skills: ['gateway-stage'], permission: { read: 'allow' }, heartbeatMs: 0, maxTokens: 100000, role: 'execution' } },
      agentTeams: view.agentTeams,
      promotionEvidenceSourceAvailable: true,
      promotionScorecards: scorecards,
      promotionDecisions: decisions,
    })
    expect(html).toContain('Arena Run List')
    expect(html).toContain('Run Detail')
    expect(html).toContain('Promotion History')
    expect(html).toContain('data-arena-select="scorecard_profile_safe"')
    expect(html).toContain('safe-builder passed all seeded-defect checks')
    expect(html).toContain('operator / mission-control')
    expect(html).toContain('regression: warning')
    expect(html).toContain('applied')
    expect(html).toContain('href="#/agent-factory"')
  })

  it('does not attribute subject-level promotion decisions to unrelated Arena runs', () => {
    const view = buildDashboardView({
      promotionEvidenceSourceAvailable: true,
      promotionScorecards: [
        {
          id: 'scorecard_profile_followup',
          subjectKind: 'profile',
          subjectName: 'safe-builder',
          subjectRevision: 'rev_followup',
          sourceKind: 'arena',
          sourceId: 'arena.fixture.followup',
          sourceVersion: '1.0.1',
          metrics: [{ id: 'arena.score', score: 7, maxScore: 8, passed: true }],
          thresholds: [{ id: 'arena.pass_threshold', metric: 'arena.score', actualScore: 0.875, actualPercentage: 0.875, passed: true }],
          evidence: ['file:/tmp/arena-followup.json'],
          conclusion: 'follow-up evidence is recorded but not yet decided',
          recommendation: 'promote',
          status: 'evaluated',
          createdAt: '2026-06-15T12:00:00.000Z',
          updatedAt: '2026-06-15T12:00:00.000Z',
        },
        {
          id: 'scorecard_profile_original',
          subjectKind: 'profile',
          subjectName: 'safe-builder',
          subjectRevision: 'rev_original',
          sourceKind: 'arena',
          sourceId: 'arena.fixture.original',
          sourceVersion: '1.0.0',
          metrics: [{ id: 'arena.score', score: 8, maxScore: 8, passed: true }],
          thresholds: [{ id: 'arena.pass_threshold', metric: 'arena.score', actualScore: 1, actualPercentage: 1, passed: true }],
          evidence: ['file:/tmp/arena-original.json'],
          conclusion: 'original evidence was promoted',
          recommendation: 'promote',
          status: 'evaluated',
          createdAt: '2026-06-15T10:00:00.000Z',
          updatedAt: '2026-06-15T10:00:00.000Z',
        },
      ],
      promotionDecisions: [
        {
          id: 'promotion_original',
          subjectKind: 'profile',
          subjectName: 'safe-builder',
          subjectRevision: 'rev_original',
          action: 'promote',
          fromStatus: 'evaluated',
          toStatus: 'promoted',
          scorecardId: 'scorecard_profile_original',
          gateId: 'gate_original',
          status: 'applied',
          actor: 'operator',
          source: 'mission-control',
          createdAt: '2026-06-15T11:00:00.000Z',
          updatedAt: '2026-06-15T11:00:00.000Z',
        },
      ],
    })

    expect(view.arena.runs.map(run => run.id)).toEqual(['scorecard_profile_followup', 'scorecard_profile_original'])
    expect(view.arena.runs[0]).toMatchObject({
      id: 'scorecard_profile_followup',
      promotionOutcome: 'promote recommended',
      gateResult: 'evaluated',
    })
    expect(view.arena.runs[1]).toMatchObject({
      id: 'scorecard_profile_original',
      promotionOutcome: 'promote applied -> promoted',
      gateResult: 'applied',
    })
    expect(view.arena.promotionHistory.map(entry => entry.id)).toContain('decision:promotion_original')
  })

  it('bounds large Mission Control fixtures with visible source contracts and redaction', () => {
    const profiles = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`profile_${index}`, {
      model: { providerID: 'openrouter', modelID: 'deepseek/deepseek-v4-pro' },
      agent: `agent_${index}`,
      skills: ['gateway-stage'],
      mcpServers: ['gateway'],
      tools: ['gateway_task_update'],
      capabilities: ['repo-write'],
      permission: { read: 'allow', edit: 'ask', bash: 'deny' },
      role: 'execution',
      maxTokens: 100000,
    }]))
    const agentTeams = {
      totals: { teams: 50, referencedTeams: 50, invalidReferences: 0, activeTasks: 250, recentRuns: 1000 },
      teams: Array.from({ length: 50 }, (_, index) => ({
        name: `team_${index}`,
        revision: `teamrev_${index}`,
        health: 'ok',
        warnings: [],
        roles: [{ stage: 'implement', profile: `profile_${index}`, agent: `agent_${index}`, model: 'openrouter/deepseek/deepseek-v4-pro', role: 'execution' }],
        capabilityRequirements: [{ stage: 'implement', capabilities: ['repo-write'] }],
        qualitySpecDefaultKeys: ['evidenceRequirements'],
        references: { roadmaps: 1, tasks: 10, activeTasks: 5, recentRuns: 20 },
      })),
      invalidReferences: [],
      recentRuns: [],
    }
    const roadmaps = Array.from({ length: 25 }, (_, index) => ({ id: `roadmap_${index}`, title: `Scale roadmap ${index}`, status: 'active', agentTeam: `team_${index % 50}` }))
    const tasks = Array.from({ length: 500 }, (_, index) => ({
      id: `task_${index}`,
      roadmapId: `roadmap_${index % roadmaps.length}`,
      title: `Scale issue ${index}`,
      status: index % 19 === 0 ? 'blocked' : index % 5 === 0 ? 'running' : index % 3 === 0 ? 'done' : 'pending',
      priority: index % 11 === 0 ? 'HIGH' : 'LOW',
      currentRunId: `run_${index}`,
      agentTeam: `team_${index % 50}`,
      readiness: index % 19 === 0 ? { reason: 'Capacity gate waiting' } : undefined,
    }))
    const runs = Array.from({ length: 1000 }, (_, index) => ({
      id: `run_${index}`,
      taskId: `task_${index % tasks.length}`,
      stage: ['implement', 'review', 'verify'][index % 3],
      status: index % 17 === 0 ? 'failed' : index % 7 === 0 ? 'running' : 'passed',
      sessionId: `ses_${index % 120}`,
      profile: `profile_${index % 50}`,
      resolvedProfile: `profile_${index % 50}`,
      resolvedAgent: `agent_${index % 50}`,
      agentTeam: `team_${index % 50}`,
      result: { summary: `scale run summary ${index}`, evidence: [`private prompt should stay internal ${index}`] },
      startedAt: '2026-06-21T09:00:00.000Z',
      completedAt: '2026-06-21T09:10:00.000Z',
    }))
    const sessions = Array.from({ length: 120 }, (_, index) => ({ id: `ses_${index}`, title: `Gateway session ${index}`, status: index % 7 === 0 ? 'running' : 'done', agent: `agent_${index % 50}`, webUrl: `http://127.0.0.1:4096/session/ses_${index}` }))
    const links = Array.from({ length: 100 }, (_, index) => ({
      provider: 'telegram',
      chatId: `raw-chat-secret-${index}`,
      threadId: `raw-thread-secret-${index}`,
      sessionId: `ses_${index % sessions.length}`,
      roadmapId: `roadmap_${index % roadmaps.length}`,
      taskId: `task_${index % tasks.length}`,
      mode: 'chat',
      title: `Scale channel ${index}`,
      createdAt: '',
      updatedAt: '',
    }))
    const events = Array.from({ length: 2000 }, (_, index) => `scale channel event ${index} for task_${index % tasks.length}`)
    const alerts = Array.from({ length: 125 }, (_, index) => ({ id: `alert_${index}`, severity: index % 10 === 0 ? 'critical' : 'warning', status: 'active', summary: `Scale alert ${index}`, target: `run_${index}`, nextAction: 'Inspect bounded window.' }))

    const view = buildDashboardView({
      profiles,
      agentTeams,
      roadmaps,
      tasks,
      runs,
      sessions,
      events,
      alerts,
      projectBindings: links.map((link, index) => ({ id: `binding_${index}`, alias: `binding_${index}`, provider: link.provider, chatId: link.chatId, threadId: link.threadId, sessionId: link.sessionId, roadmapId: link.roadmapId, notificationMode: 'immediate' })),
      channels: { providers: [], sync: { active: true, syncEnabled: true, intervalMs: 3000, includeUserMessages: true, deliveriesTracked: 1000, pendingInbound: 3 }, links, connectorRegistry: { generatedAt: '2026-06-21T09:00:00.000Z', connectors: [], counts: {} } },
      environments: Array.from({ length: 140 }, (_, index) => ({ id: `env_${index}`, name: `env_${index}`, backend: 'local-process', status: index % 13 === 0 ? 'cleanup_failed' : 'released', cleanup: { state: index % 13 === 0 ? 'failed' : 'released' }, runId: `run_${index}`, artifacts: [] })),
      promotionScorecards: Array.from({ length: 140 }, (_, index) => ({ id: `scorecard_${index}`, subjectKind: 'profile', subjectName: `profile_${index % 50}`, sourceKind: 'arena', sourceId: `fixture_${index}`, metrics: [], evidence: [`file:/tmp/evidence_${index}.json`], status: 'evaluated' })),
      dashboardWindowOptions: { tasks: { limit: 200 }, runs: { limit: 100 }, events: { limit: 200 }, sessions: { limit: 80 }, channelBindings: { limit: 80 }, workGraphNodes: { limit: 180 }, workGraphEdges: { limit: 180 } },
      workGraphSourceAvailable: { tasks: true, roadmaps: true, projectBindings: true, runs: true, sessions: true, channels: true, alerts: true },
    })
    const searched = buildDashboardView({
      tasks,
      dashboardWindowOptions: { tasks: { search: 'Scale issue 49', limit: 10 } },
      workGraphSourceAvailable: { tasks: true },
    })
    const html = renderDashboardDocument({
      profiles,
      agentTeams,
      roadmaps,
      tasks,
      runs,
      sessions,
      events,
      alerts,
      projectBindings: links.map((link, index) => ({ id: `binding_${index}`, alias: `binding_${index}`, provider: link.provider, chatId: link.chatId, threadId: link.threadId, sessionId: link.sessionId, roadmapId: link.roadmapId, notificationMode: 'immediate' })),
      channels: { providers: [], sync: { active: true, syncEnabled: true, intervalMs: 3000, includeUserMessages: true, deliveriesTracked: 1000, pendingInbound: 3 }, links, connectorRegistry: { generatedAt: '2026-06-21T09:00:00.000Z', connectors: [], counts: {} } },
      promotionScorecards: Array.from({ length: 140 }, (_, index) => ({ id: `scorecard_${index}`, subjectKind: 'profile', subjectName: `profile_${index % 50}`, sourceKind: 'arena', sourceId: `fixture_${index}`, metrics: [], evidence: [`file:/tmp/evidence_${index}.json`], status: 'evaluated' })),
      dashboardWindowOptions: { tasks: { limit: 200 }, runs: { limit: 100 }, events: { limit: 200 }, sessions: { limit: 80 }, channelBindings: { limit: 80 }, workGraphNodes: { limit: 180 }, workGraphEdges: { limit: 180 } },
      workGraphSourceAvailable: { tasks: true, roadmaps: true, projectBindings: true, runs: true, sessions: true, channels: true, alerts: true },
    })

    expect(view.windows['tasks']).toMatchObject({ total: 500, shown: 200, truncated: true })
    expect(view.windows['runs']).toMatchObject({ total: 1000, shown: 100, truncated: true })
    expect(view.windows['events']).toMatchObject({ total: 2000, shown: 200, truncated: true })
    expect(view.windows['channelBindings']).toMatchObject({ total: 100, shown: 80, truncated: true })
    expect(view.windows['agentProfiles']).toMatchObject({ total: 50, shown: 50, truncated: false })
    expect(view.windows['agentTeams']).toMatchObject({ total: 50, shown: 50, truncated: false })
    expect(searched.windows['tasks']).toMatchObject({ total: 500, matched: 11, shown: 10, truncated: true, search: 'Scale issue 49' })
    expect(view.workGraph.window.nodes.shown).toBeLessThanOrEqual(180)
    expect(view.workGraph.window.edges.shown).toBeLessThanOrEqual(180)
    expect(view.dataPlane).toMatchObject({
      mode: 'm41_mission_control_data_plane_v2',
      status: expect.stringMatching(/^(bounded|degraded)$/),
      windowTotals: expect.objectContaining({
        sources: expect.any(Number),
        truncatedSources: expect.any(Number),
        shownRows: expect.any(Number),
      }),
    })
    expect(html.length).toBeLessThan(900_000)
    expect(html).toContain('Data Plane V2')
    expect(html).toContain('data-testid="mission-control-data-plane-v2"')
    expect(html).toContain('local_beta_high_volume_read_model_only_no_hosted_or_unattended_claim')
    expect(html).toContain('Window Contracts')
    expect(html).toContain('data-testid="source-contract-tasks"')
    expect(html).toContain('200 of 500')
    expect(html).toContain('100 of 1,000')
    expect(html).toContain('table-layout:fixed')
    expect(html).toContain('overflow-wrap:anywhere')
    expect(html).toContain('text-overflow:ellipsis')
    expect(html).not.toContain('raw-chat-secret')
    expect(html).not.toContain('raw-thread-secret')
    expect(html).not.toContain('private prompt should stay internal')
  })

  it('shows degraded high-cardinality source contracts without empty-success states', () => {
    const view = buildDashboardView({
      tasks: [],
      runs: [],
      events: [],
      sessions: [],
      alerts: [],
      channels: { providers: [], sync: { active: false, syncEnabled: false, intervalMs: 0, includeUserMessages: false, deliveriesTracked: 0, pendingInbound: 0 }, links: [], connectorRegistry: { generatedAt: '2026-06-21T09:00:00.000Z', connectors: [], counts: {} } },
      teamAssignments: [],
      promotionScorecards: [],
      sourceDiagnostics: [{ source: 'opencode_sessions', available: false, summary: 'OpenCode sessions unavailable' }],
      sourceAvailability: { events: false, evidence: false },
      workGraphSourceAvailable: { tasks: false, runs: false, sessions: false, channels: false, alerts: false, teamAssignments: false },
    })
    const html = renderDashboardDocument({
      tasks: [],
      runs: [],
      events: [],
      sessions: [],
      alerts: [],
      channels: { providers: [], sync: { active: false, syncEnabled: false, intervalMs: 0, includeUserMessages: false, deliveriesTracked: 0, pendingInbound: 0 }, links: [], connectorRegistry: { generatedAt: '2026-06-21T09:00:00.000Z', connectors: [], counts: {} } },
      teamAssignments: [],
      promotionScorecards: [],
      sourceDiagnostics: [{ source: 'opencode_sessions', available: false, summary: 'OpenCode sessions unavailable' }],
      sourceAvailability: { events: false, evidence: false },
      workGraphSourceAvailable: { tasks: false, runs: false, sessions: false, channels: false, alerts: false, teamAssignments: false },
    })

    for (const key of ['tasks', 'runs', 'events', 'sessions', 'channelBindings', 'alerts', 'teamAssignments', 'evidence']) {
      expect(view.windows[key]).toMatchObject({ available: false })
      expect(html).toContain(`data-testid="source-contract-${key}"`)
    }
    expect(html).toContain('Source Diagnostics')
    expect(html).toContain('opencode_sessions')
    expect(html).toContain('tasks')
    expect(html).toContain('runs')
    expect(html).toContain('channelBindings')
    expect(html).toContain('unavailable')
    expect(html).not.toContain('All named Mission Control sources loaded.')
  })
})

function clearChannelEnvForDashboardTest(): void {
  delete process.env['TELEGRAM_BOT_TOKEN']
  delete process.env['WHATSAPP_ACCESS_TOKEN']
  delete process.env['WHATSAPP_PHONE_NUMBER_ID']
  delete process.env['WHATSAPP_VERIFY_TOKEN']
  delete process.env['WHATSAPP_APP_SECRET']
  delete process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED']
  delete process.env['DISCORD_BOT_TOKEN']
  delete process.env['DISCORD_PUBLIC_KEY']
}
