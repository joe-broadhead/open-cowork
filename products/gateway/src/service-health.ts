import * as fs from 'node:fs'
import { evaluateChannelServicePolicy } from './channel-service-policy.js'
import { getConfig, getConfigPath, type GatewayConfig } from './config.js'
import { getCurrentDaemonLeadershipStatus, redactDaemonLeadershipSnapshot } from './daemon-leadership.js'
import { getHeartbeatStatus } from './heartbeat.js'
import { buildChannelConnectorRegistry } from './channel-connectors.js'
import { getChannelSyncSummary } from './channel-sync.js'
import { listChannelSessions } from './channel-sessions.js'
import { getWorkQueueSnapshot } from './scheduler.js'
import { allowsAllChannelTargets, hasChannelAllowlist, isChannelProviderConfigured, redactSensitiveText } from './security.js'
import { runStorageDoctor } from './storage.js'
import { openCodeFetch } from './opencode-client.js'
import { withDeadline } from './deadlines.js'

export type ServiceHealthStatus = 'ok' | 'degraded' | 'down'
export type ServiceHealthComponentId =
  | 'daemon'
  | 'leadership'
  | 'dashboard'
  | 'storage'
  | 'scheduler'
  | 'channel:telegram'
  | 'channel:whatsapp'
  | 'channel:discord'
  | 'opencode'
  | 'config'

export interface ServiceHealthComponent {
  id: ServiceHealthComponentId
  label: string
  status: ServiceHealthStatus
  summary: string
  detail?: string
  remediation: string
  evidence?: Record<string, unknown>
  releaseBlocking?: boolean
  deferred?: boolean
}

export interface ServiceHealthReport {
  status: ServiceHealthStatus
  generatedAt: string
  summary: string
  components: ServiceHealthComponent[]
  counts: Record<ServiceHealthStatus, number>
  releaseBlockingCounts?: Record<ServiceHealthStatus, number>
  serviceCounts?: Record<ServiceHealthStatus, number>
  attention: ServiceHealthComponent[]
  deferred: ServiceHealthComponent[]
}

export interface ServiceHealthOptions {
  client?: any
  daemon?: { pid?: number; uptime?: number; port?: number }
  config?: GatewayConfig
  opencodeReachable?: boolean
}

export async function buildServiceHealthReport(options: ServiceHealthOptions = {}): Promise<ServiceHealthReport> {
  const config = options.config || getConfig()
  const components: ServiceHealthComponent[] = [
    daemonHealth(config, options.daemon),
    leadershipHealth(),
    dashboardHealth(config, options.daemon),
    storageHealth(),
    schedulerHealth(config),
    ...channelHealth(config),
    await opencodeHealth(config, options),
    configHealth(config),
  ]
  return aggregateServiceHealth(components)
}

export function buildOfflineServiceHealthReport(input: { reason: string; config?: GatewayConfig } = { reason: 'Gateway daemon is unreachable.' }): ServiceHealthReport {
  let config = input.config
  let configComponent: ServiceHealthComponent
  try {
    config = config || getConfig()
    configComponent = configHealth(config)
  } catch (err: any) {
    configComponent = component('config', 'Config', 'down', 'Gateway config is invalid.', err?.message || String(err), 'Run `opencode-gateway setup` or fix the JSON reported above.')
  }
  const port = config?.httpPort || 4097
  return aggregateServiceHealth([
    component('daemon', 'Daemon', 'down', input.reason, `Expected health endpoint at http://127.0.0.1:${port}/health.`, 'Run `opencode-gateway start`; if it still fails, inspect `opencode-gateway logs`.'),
    component('dashboard', 'Dashboard', 'down', 'Mission Control is unavailable because the daemon is down.', `Expected dashboard at http://127.0.0.1:${port}/dashboard.`, 'Start the daemon, then reload Mission Control.'),
    configComponent,
  ])
}

export function aggregateServiceHealth(components: ServiceHealthComponent[]): ServiceHealthReport {
  const counts = { ok: 0, degraded: 0, down: 0 }
  for (const row of components) counts[row.status] += 1
  const releaseBlockingComponents = components.filter(row => row.releaseBlocking !== false)
  const attention = releaseBlockingComponents.filter(row => row.status !== 'ok')
  const deferred = components.filter(row => row.status !== 'ok' && row.releaseBlocking === false)
  const releaseBlockingCounts = { ok: 0, degraded: 0, down: 0 }
  for (const row of releaseBlockingComponents) releaseBlockingCounts[row.status] += 1
  const status: ServiceHealthStatus = releaseBlockingCounts.down ? 'down' : releaseBlockingCounts.degraded ? 'degraded' : 'ok'
  const summary = status === 'ok'
    ? deferred.length
      ? `All ${releaseBlockingComponents.length} release-blocking service components are healthy; ${deferred.length} deferred/non-blocking component${deferred.length === 1 ? '' : 's'} remain visible.`
      : `All ${components.length} service components are healthy.`
    : `${attention.length} of ${components.length} service component${components.length === 1 ? '' : 's'} need attention.`
  return { status, generatedAt: new Date().toISOString(), summary, components, counts, releaseBlockingCounts, serviceCounts: counts, attention, deferred }
}

function daemonHealth(config: GatewayConfig, daemon?: ServiceHealthOptions['daemon']): ServiceHealthComponent {
  if (!daemon) {
    return component('daemon', 'Daemon', 'degraded', 'Daemon health is being inferred without process metadata.', `Port ${config.httpPort} responded, but pid/uptime metadata was not supplied.`, 'Check `opencode-gateway status` from the host shell.')
  }
  return component('daemon', 'Daemon', 'ok', `Daemon is running on port ${daemon.port || config.httpPort}.`, `pid ${daemon.pid || process.pid}, uptime ${Math.floor(Number(daemon.uptime || 0))}s`, 'No action required.', { pid: daemon.pid || process.pid, uptime: daemon.uptime || 0, port: daemon.port || config.httpPort })
}

function leadershipHealth(): ServiceHealthComponent {
  const snapshot = redactDaemonLeadershipSnapshot(getCurrentDaemonLeadershipStatus())
  if (snapshot.mode === 'writer' || snapshot.mode === 'single_daemon') {
    return component(
      'leadership',
      'Daemon Leadership',
      'ok',
      snapshot.mode === 'writer' ? 'This daemon owns the local writer lease.' : 'Single-daemon compatibility mode is active.',
      leadershipDetail(snapshot),
      'No action required.',
      snapshot as unknown as Record<string, unknown>,
    )
  }
  const status: ServiceHealthStatus = snapshot.mode === 'unavailable' ? 'down' : 'degraded'
  return component(
    'leadership',
    'Daemon Leadership',
    status,
    snapshot.mode === 'standby'
      ? 'Another Gateway daemon owns the local writer lease.'
      : snapshot.mode === 'no_leader'
        ? 'No Gateway daemon owns the local writer lease.'
        : 'Gateway leadership state is unavailable.',
    leadershipDetail(snapshot),
    snapshot.remediation,
    snapshot as unknown as Record<string, unknown>,
  )
}

function leadershipDetail(snapshot: ReturnType<typeof redactDaemonLeadershipSnapshot>): string {
  const bits = [
    `mode ${snapshot.mode}`,
    `this ${snapshot.instanceId}`,
    snapshot.leaderId ? `leader ${snapshot.leaderId}` : undefined,
    snapshot.leaseRemainingMs !== undefined ? `lease remaining ${Math.round(snapshot.leaseRemainingMs / 1000)}s` : undefined,
    snapshot.stale ? 'stale' : undefined,
  ].filter(Boolean)
  return bits.join(', ')
}

function dashboardHealth(config: GatewayConfig, daemon?: ServiceHealthOptions['daemon']): ServiceHealthComponent {
  const running = Boolean(daemon)
  return component(
    'dashboard',
    'Dashboard',
    running ? 'ok' : 'down',
    running ? 'Mission Control route is served by the daemon.' : 'Mission Control is unavailable because the daemon is down.',
    `http://127.0.0.1:${config.httpPort}/dashboard`,
    running ? 'Open the dashboard URL when operator visibility is needed.' : 'Start the daemon, then reload Mission Control.',
  )
}

function storageHealth(): ServiceHealthComponent {
  try {
    const doctor = runStorageDoctor()
    const actionable = doctor.issues.filter(issue => issue.severity !== 'info')
    if (doctor.status === 'ok') {
      return component(
        'storage',
        'Storage',
        'ok',
        'Gateway storage sources are consistent.',
        doctor.counts ? `${doctor.counts.tasks} Issues, ${doctor.counts.runs} runs, ${doctor.sources.length} tracked sources` : `${doctor.sources.length} tracked sources`,
        'No action required.',
        doctor as unknown as Record<string, unknown>,
      )
    }
    const releaseBlockingIssues = actionable.filter(isReleaseBlockingStorageIssue)
    const nonBlockingIssues = actionable.filter(issue => !isReleaseBlockingStorageIssue(issue))
    return component(
      'storage',
      'Storage',
      doctor.status === 'down' ? 'down' : 'degraded',
      doctor.status === 'down'
        ? 'Gateway storage has critical consistency failures.'
        : releaseBlockingIssues.length
          ? 'Gateway storage has consistency warnings.'
          : 'Gateway storage has non-blocking local-beta consistency warnings.',
      actionable.map(issue => `${issue.code}: ${issue.summary}`).join('; ') || doctor.summary,
      storageRemediation(releaseBlockingIssues, nonBlockingIssues),
      {
        ...(doctor as unknown as Record<string, unknown>),
        releaseBlockingIssueCodes: releaseBlockingIssues.map(issue => issue.code),
        nonBlockingIssueCodes: nonBlockingIssues.map(issue => issue.code),
        localBetaWaiver: releaseBlockingIssues.length ? undefined : 'historical_session_receipt_attention_visible_non_blocking',
      },
      doctor.status !== 'down' && releaseBlockingIssues.length === 0
        ? { releaseBlocking: false, deferred: true }
        : undefined,
    )
  } catch (err: any) {
    return component('storage', 'Storage', 'down', 'Gateway storage doctor failed.', err?.message || String(err), 'Inspect state directory permissions and run `opencode-gateway backup doctor --json` from the host shell.')
  }
}

function isReleaseBlockingStorageIssue(issue: { severity: string; code: string }): boolean {
  if (issue.severity === 'critical') return true
  return !NON_BLOCKING_LOCAL_BETA_STORAGE_ISSUES.has(issue.code)
}

const NON_BLOCKING_LOCAL_BETA_STORAGE_ISSUES = new Set([
  'project_binding_session_missing',
  'supervisor_session_missing',
  'channel_binding_session_missing',
  'progress_route_receipt_progress_missing',
  'progress_route_receipt_event_missing',
  'wakeup_receipt_lease_expired',
])

function storageRemediation(
  releaseBlockingIssues: Array<{ remediation: string }>,
  nonBlockingIssues: Array<{ remediation: string }>,
): string {
  if (releaseBlockingIssues[0]?.remediation) return releaseBlockingIssues[0].remediation
  if (!nonBlockingIssues.length) return 'Run `opencode-gateway backup doctor --json` and follow the reported remediation.'
  return [
    'Non-blocking local-beta storage attention is visible for operator repair but does not block service health.',
    'Run `opencode-gateway backup doctor --json` for the full issue list, then use project/channel rebind, sidecar refresh, or supervisor recovery as indicated before claiming cross-surface recovery evidence.',
  ].join(' ')
}

function schedulerHealth(config: GatewayConfig): ServiceHealthComponent {
  const heartbeat = getHeartbeatStatus()
  let counts: any = {}
  try { counts = getWorkQueueSnapshot().counts } catch {}
  if (!config.scheduler.enabled) {
    return component('scheduler', 'Scheduler', 'degraded', 'Scheduler is disabled.', 'Durable Issues will not dispatch until scheduler.enabled is true.', 'Enable scheduler.enabled in Gateway config or dispatch work manually.', { enabled: false, counts })
  }
  if (heartbeat.status === 'error') {
    return component('scheduler', 'Scheduler', 'down', 'Scheduler heartbeat is failing.', heartbeat.lastError || heartbeat.lastSummary || 'heartbeat error', 'Inspect `opencode-gateway logs`, fix the failing dependency, then run `opencode-gateway restart`.', { heartbeat, counts })
  }
  const status = heartbeat.status === 'never' ? 'degraded' : 'ok'
  return component(
    'scheduler',
    'Scheduler',
    status,
    status === 'ok' ? 'Scheduler is enabled and heartbeat state is healthy.' : 'Scheduler is enabled but has not completed a heartbeat yet.',
    heartbeat.lastSummary || `interval ${config.scheduler.intervalMs}ms, max ${config.scheduler.maxConcurrent}`,
    status === 'ok' ? 'No action required.' : 'Wait for the first heartbeat or run `opencode-gateway status` again after the configured interval.',
    { heartbeat, counts },
  )
}

function channelHealth(config: GatewayConfig): ServiceHealthComponent[] {
  try {
    const links = listChannelSessions()
    const sync = getChannelSyncSummary()
    const connectorRegistry = buildChannelConnectorRegistry({ config, bindings: links })
    return (['telegram', 'whatsapp', 'discord'] as const).map(provider => {
      const connector = connectorRegistry.connectors.find(row => row.provider === provider)
      const configured = connector?.configured ?? channelConfigured(provider, config)
      const trusted = connector?.trusted ?? (hasChannelAllowlist(provider, config) || allowsAllChannelTargets(provider, config))
      const unsafe = connector?.unsafeAllowAll ?? allowsAllChannelTargets(provider, config)
      const enabled = connector?.enabled ?? configured
      const policy = evaluateChannelServicePolicy({
        provider,
        displayName: capitalize(provider),
        configured,
        enabled,
        trusted,
        unsafeAllowAll: unsafe,
        connector,
      })
      const bindings = links.filter(link => link.provider === provider).length
      const syncDetail = config.channelSync.enabled ? `sync ${sync.active ? 'active' : 'idle'}, ${sync.pendingInbound} pending inbound` : 'sync disabled'
      const connectorDetail = connector ? `lifecycle ${connector.state}, ${connector.missingPrerequisites.length} setup prerequisite${connector.missingPrerequisites.length === 1 ? '' : 's'}` : 'lifecycle unavailable'
      const optionalUnbound = provider !== 'telegram' && bindings === 0 && policy.status !== 'ok'
      return component(
        `channel:${provider}`,
        `${capitalize(provider)} Adapter`,
        policy.status,
        policy.summary,
        `${bindings} binding${bindings === 1 ? '' : 's'}, adapter ${enabled ? 'enabled' : 'disabled'}, ${connectorDetail}, ${syncDetail}`,
        policy.remediation,
        {
          ...policy.evidence,
          bindings,
          syncActive: sync.active,
          pendingInbound: sync.pendingInbound,
          localBetaOptional: optionalUnbound,
        },
        optionalUnbound ? { releaseBlocking: false, deferred: true } : undefined,
      )
    })
  } catch (err: any) {
    return [
      component('channel:telegram', 'Telegram Adapter', 'down', 'Telegram adapter health could not be evaluated.', err?.message || String(err), 'Check channel config and run `opencode-gateway doctor`.'),
      component('channel:whatsapp', 'WhatsApp Adapter', 'down', 'WhatsApp adapter health could not be evaluated.', err?.message || String(err), 'Check channel config and run `opencode-gateway doctor`.'),
      component('channel:discord', 'Discord Adapter', 'down', 'Discord adapter health could not be evaluated.', err?.message || String(err), 'Check channel config and run `opencode-gateway doctor`.'),
    ]
  }
}

function channelConfigured(provider: 'telegram' | 'whatsapp' | 'discord', config: GatewayConfig): boolean {
  if (provider === 'telegram') return Boolean(process.env['TELEGRAM_BOT_TOKEN'] || config.channels.telegram?.botToken)
  if (provider === 'discord') return isChannelProviderConfigured('discord', config)
  const cfg = config.channels.whatsapp || {}
  return Boolean(
    (process.env['WHATSAPP_ACCESS_TOKEN'] || cfg.accessToken) &&
    (process.env['WHATSAPP_PHONE_NUMBER_ID'] || cfg.phoneNumberId) &&
    (process.env['WHATSAPP_VERIFY_TOKEN'] || cfg.verifyToken)
  )
}

async function opencodeHealth(config: GatewayConfig, options: ServiceHealthOptions): Promise<ServiceHealthComponent> {
  if (typeof options.opencodeReachable === 'boolean') {
    return options.opencodeReachable
      ? component('opencode', 'OpenCode Connectivity', 'ok', 'OpenCode health endpoint is reachable.', config.opencodeUrl, 'No action required.')
      : component('opencode', 'OpenCode Connectivity', 'down', 'OpenCode health endpoint is unreachable.', config.opencodeUrl, 'Start OpenCode or update opencodeUrl in Gateway config.')
  }

  if (options.client?.session?.list) {
    try {
      await withDeadline(Promise.resolve(options.client.session.list()), 2000, 'OpenCode session list')
      return component('opencode', 'OpenCode Connectivity', 'ok', 'OpenCode client can list sessions.', config.opencodeUrl, 'No action required.')
    } catch (err: any) {
      return component('opencode', 'OpenCode Connectivity', 'down', 'OpenCode client cannot list sessions.', err?.message || String(err), 'Start OpenCode, verify `opencodeUrl`, then restart Gateway.')
    }
  }

  try {
    const res = await openCodeFetch(config.opencodeUrl, 'global/health', {}, { timeoutMs: 2000 })
    if (res.ok) return component('opencode', 'OpenCode Connectivity', 'ok', 'OpenCode health endpoint is reachable.', config.opencodeUrl, 'No action required.', { status: res.status })
    return component('opencode', 'OpenCode Connectivity', 'down', 'OpenCode health endpoint returned an error.', `HTTP ${res.status} from ${config.opencodeUrl}`, 'Start OpenCode or update opencodeUrl in Gateway config.', { status: res.status })
  } catch (err: any) {
    return component('opencode', 'OpenCode Connectivity', 'down', 'OpenCode health endpoint is unreachable.', redactSensitiveText(err?.message || String(err)), 'Start OpenCode or update opencodeUrl in Gateway config.')
  }
}

function configHealth(config: GatewayConfig): ServiceHealthComponent {
  const warnings: string[] = []
  if (!fs.existsSync(getConfigPath())) warnings.push('config file does not exist; defaults are in use')
  if (!config.scheduler.defaultPipeline.length) warnings.push('scheduler.defaultPipeline is empty')
  if (!config.profiles['implementer']) warnings.push('implementer profile is missing')
  if (!config.security.httpHost) warnings.push('security.httpHost is empty')
  const status: ServiceHealthStatus = warnings.length ? 'degraded' : 'ok'
  return component(
    'config',
    'Config',
    status,
    status === 'ok' ? 'Gateway config is valid.' : 'Gateway config is valid with operator warnings.',
    warnings.length ? warnings.join('; ') : getConfigPath(),
    status === 'ok' ? 'No action required.' : 'Run `opencode-gateway setup` or `opencode-gateway update --wizard` to write an explicit private-alpha config.',
    { path: getConfigPath() },
  )
}

function component(
  id: ServiceHealthComponentId,
  label: string,
  status: ServiceHealthStatus,
  summary: string,
  detail: string | undefined,
  remediation: string,
  evidence?: Record<string, unknown>,
  options: Pick<ServiceHealthComponent, 'releaseBlocking' | 'deferred'> = {},
): ServiceHealthComponent {
  return { id, label, status, summary, detail, remediation, evidence, ...options }
}

function capitalize(value: string): string {
  if (value === 'whatsapp') return 'WhatsApp'
  return value.charAt(0).toUpperCase() + value.slice(1)
}
