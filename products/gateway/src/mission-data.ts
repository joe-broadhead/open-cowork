import * as fs from 'node:fs'
import * as path from 'node:path'
import { z } from 'zod'
import { getConfig, getConfigDir, type AgentProfile, type AgentTeamConfig, type GatewayConfig } from './config.js'
import { getHeartbeatStatus } from './heartbeat.js'
import { opencodeSessionWebUrl } from './opencode-web.js'
import { getOpenCodeUsage, type UsageWindow } from './opencode-usage.js'
import { getWorkQueueSnapshot } from './scheduler.js'
import { buildReadinessReport } from './readiness.js'
import { buildGovernanceReport } from './governance.js'
import { buildNeedsAttentionReport } from './human-loop.js'
import { runAlertEngine } from './alerts.js'
import { buildSupervisorObservability } from './supervisor-observability.js'
import { getChannelSyncSummary, type ChannelSyncSummary } from './channel-sync.js'
import { listChannelSessions } from './channel-sessions.js'
import { allowsAllChannelTargets, hasChannelAllowlist, isChannelProviderConfigured, redactSensitiveText } from './security.js'
import { listHumanGates, listHumanGatesReadOnly, listWorkEnvironments, listWorkTaskViews, loadWorkState, loadWorkStateReadOnly, summarizeWorkTasks, type ChannelBindingRecord, type HumanGateRecord, type ProjectBindingRecord, type RoadmapRecord, type RunRecord, type WorkDependencyRecord, type WorkState, type WorkTaskRecord, type WorkTaskView } from './work-store.js'
import { getRunReadOnly, getRunsForRoadmap, getRunsForTask } from './work-store/queries.js'
import { listPromotionDecisions, listPromotionScorecards } from './work-store/promotions.js'
import { buildAgentCatalog } from './agent-catalog.js'
import { buildServiceHealthReport } from './service-health.js'
import { listTeamTaskAssignments } from './team-assignment.js'
import { listStorageBackups, listStorageRecoveryDrills } from './storage.js'
import { buildAlphaHealthSummary } from './alpha-health.js'
import { buildChannelConnectorRegistry, type ChannelConnectorRegistry } from './channel-connectors.js'
import { buildOperatorSafetyReport } from './operator-safety.js'
import { buildCapacityReport } from './capacity.js'
import { buildObservabilitySnapshot } from './observability-snapshot.js'
import { buildOperationsCockpit } from './mission-control-view-model.js'
import { channelActionParityMatrix, channelActionProviderControlSummaries, type ChannelActionParityRow, type ChannelActionProviderControlSummary } from './channel-actions.js'
import { openCodeEndpointUrl, safeOpenCodeBaseUrl } from './opencode-url-policy.js'
import { fetchWithTimeout } from './deadlines.js'

export interface RunThroughputPoint {
  date: string
  done: number
  cost: number
}

export interface MissionChannelSummary {
  providers: Array<{
    provider: 'telegram' | 'whatsapp' | 'discord'
    configured: boolean
    enabled: boolean
    bindings: number
    health: 'ok' | 'degraded' | 'down'
    note: string
  }>
  sync: ChannelSyncSummary & {
    syncEnabled: boolean
    intervalMs: number
    includeUserMessages: boolean
  }
  links: ChannelBindingRecord[]
  connectorRegistry: ChannelConnectorRegistry
  actionParity: ChannelActionParityRow[]
  nativeControlCoverage: ChannelActionProviderControlSummary[]
}

export interface MissionAgentTeamSummary {
  totals: {
    teams: number
    referencedTeams: number
    invalidReferences: number
    activeTasks: number
    recentRuns: number
  }
  teams: Array<{
    name: string
    description?: string
    version?: string
    promotionState?: string
    revision: string
    health: 'ok' | 'warning'
    warnings: string[]
    roles: Array<{ stage: string; profile: string; agent?: string; model?: string; role?: string }>
    capabilityRequirements: Array<{ stage: string; capabilities: string[] }>
    qualitySpecDefaultKeys: string[]
    references: { roadmaps: number; tasks: number; activeTasks: number; recentRuns: number }
  }>
  invalidReferences: Array<{ kind: 'roadmap' | 'task' | 'run'; id: string; title?: string; agentTeam: string; reason: string }>
  recentRuns: Array<{
    id: string
    taskId: string
    stage: string
    status: string
    agentTeam?: string
    agentTeamVersion?: string
    resolvedProfile?: string
    resolvedAgent?: string
    profile?: string
    sessionId?: string
    startedAt?: string
    completedAt?: string
  }>
}

export interface MissionDataOptions {
  usageWindow?: UsageWindow
  dashboardWindowOptions?: Record<string, any>
  workStateFile?: string
  channelSyncStateFile?: string
}

export interface MissionDataSourceDiagnostic {
  source: string
  available: boolean
  summary: string
}

export interface MissionDataSourceAvailability {
  tasks: boolean
  roadmaps: boolean
  projectBindings: boolean
  runs: boolean
  supervisors: boolean
  sessions: boolean
  channels: boolean
  humanGates: boolean
  completionProposals: boolean
  requests: boolean
  alerts: boolean
  teamAssignments: boolean
  observability: boolean
}

/**
 * Shape of an OpenCode `/session` row consumed by the mission dashboard. Only
 * the fields the dashboard reads are declared; `.loose()` preserves the rest so
 * link building (directory/path) keeps working. A row missing the required `id`
 * is dropped rather than silently rendered blank — this is the guard against an
 * upstream field rename quietly emptying the dashboard.
 */
export const MissionSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  cost: z.number().optional(),
  agent: z.string().optional(),
  directory: z.string().optional(),
  path: z.string().optional(),
  tokens: z.object({ input: z.number().optional() }).loose().optional(),
  model: z.object({}).loose().optional(),
  time: z.object({ created: z.number().optional() }).loose().optional(),
}).loose()

export type MissionSessionSummary = z.infer<typeof MissionSessionSummarySchema>

export interface MissionGatewaySessionSummary {
  id: string
  title: string
  status: 'running' | 'done'
  cost: number
  tokens: Record<string, unknown>
  model: Record<string, unknown>
  agent: string
  created: number
  webUrl: string
}

export interface MissionDataContract {
  dashboardWindowOptions: Record<string, any>
  sourceDiagnostics: MissionDataSourceDiagnostic[]
  workGraphSourceAvailable: MissionDataSourceAvailability
  promotionEvidenceSourceAvailable: boolean
  sessions: MissionGatewaySessionSummary[]
  counts: { total: number; running: number; completed: number }
  tasks: unknown[]
  profiles: GatewayConfig['profiles']
  events: unknown[]
  questions: unknown[]
  permissions: unknown[]
  requestSourceAvailable: boolean
  usage?: any
  heartbeat?: any
  readiness?: any
  serviceHealth?: any
  pipeline?: string[]
  scheduler?: GatewayConfig['scheduler']
  operator?: any
  backups?: any[]
  recoveryDrills?: any[]
  roadmaps?: WorkState['roadmaps']
  projectBindings?: WorkState['projectBindings']
  completionProposals?: WorkState['completionProposals']
  humanGates?: any[]
  promotionScorecards?: any[]
  promotionDecisions?: any[]
  runs?: WorkState['runs']
  alphaHealthRuns?: WorkState['runs']
  environments?: any
  throughput?: RunThroughputPoint[]
  supervisorObservability?: { supervisors?: any }
  supervisors?: any
  governance?: any
  attention?: any
  teamAssignments?: any[]
  agentTeams?: MissionAgentTeamSummary
  agentCatalog?: any
  channels?: MissionChannelSummary
  capacity?: any
  traceCorrelation?: any
  observabilitySlo?: any
  supportOperations?: any
  alerts?: any[]
  metrics?: any
  executions?: any[]
  alphaHealth?: any
  operationsCockpit?: any
}

/**
 * Input contract for the dashboard view-model builder. It is the mission-data
 * surface the dashboard actually consumes: every key is one of the known
 * `MissionDataContract` fields (so a typo or a read of a field that mission-data
 * never produces is a compile error), plus the two optional caller-supplied
 * aliases (`generatedAt`, `sourceAvailability`) that the builder still honours.
 * Values stay loose because the builder defensively funnels each field through
 * `asArray`/fallbacks; the point of the type is to pin the *field set*, not to
 * re-derive every nested record shape.
 */
export type DashboardMissionData =
  & { [K in keyof MissionDataContract]?: any }
  & { generatedAt?: string; sourceAvailability?: Record<string, any> }

const SESSION_CACHE_TTL_MS = 3000
const REQUEST_CACHE_TTL_MS = 2000
let sessionCache: { key: string; expiresAt: number; sessions: MissionSessionSummary[] } | undefined
let requestCache: { expiresAt: number; questions: any[]; permissions: any[]; available: boolean } | undefined

// Each dashboard tab reloads every 60s and every request rebuilds readiness,
// service health, governance, and the full work-queue snapshot. A short TTL
// cache (with in-flight promise sharing) lets N tabs and API callers share one
// rebuild without meaningfully staling the view.
const MISSION_DATA_CACHE_TTL_MS = 3000
const missionDataCache = new Map<string, { expiresAt: number; promise: Promise<MissionDataContract> }>()

export function clearMissionDataCacheForTest(): void {
  missionDataCache.clear()
}

export async function getMissionData(options: MissionDataOptions = {}): Promise<MissionDataContract> {
  const key = JSON.stringify(options)
  const now = Date.now()
  const cached = missionDataCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise
  for (const [cacheKey, entry] of missionDataCache) {
    if (entry.expiresAt <= now) missionDataCache.delete(cacheKey)
  }
  const promise = buildMissionData(options)
  missionDataCache.set(key, { expiresAt: now + MISSION_DATA_CACHE_TTL_MS, promise })
  promise.catch(() => missionDataCache.delete(key))
  return promise
}

async function buildMissionData(options: MissionDataOptions = {}): Promise<MissionDataContract> {
  const config = getConfig()
  const data: MissionDataContract = {
    dashboardWindowOptions: options.dashboardWindowOptions || {},
    sourceDiagnostics: [],
    workGraphSourceAvailable: {
      tasks: false,
      roadmaps: false,
      projectBindings: false,
      runs: false,
      supervisors: false,
      sessions: false,
      channels: false,
      humanGates: false,
      completionProposals: false,
      requests: false,
      alerts: false,
      teamAssignments: false,
      observability: false,
    },
    promotionEvidenceSourceAvailable: false,
    sessions: [],
    counts: { total: 0, running: 0, completed: 0 },
    tasks: [],
    profiles: {},
    events: [],
    questions: [],
    permissions: [],
    requestSourceAvailable: false,
  }
  let workState: any

  data.usage = getOpenCodeUsage({ window: options.usageWindow, opencodeUrl: config.opencodeUrl })
  data.heartbeat = getHeartbeatStatus()
  data.readiness = await buildReadinessReport().catch((err: any) => ({ state: 'not_ready', summary: err?.message || String(err), checks: [] }))
  data.serviceHealth = await buildServiceHealthReport({ daemon: { pid: process.pid, uptime: process.uptime(), port: config.httpPort } }).catch((err: any) => ({ status: 'down', summary: err?.message || String(err), components: [], counts: { ok: 0, degraded: 0, down: 1 }, attention: [] }))
  data.pipeline = config.scheduler.defaultPipeline
  data.scheduler = config.scheduler
  data.operator = await buildOperatorSafetyReport(undefined, { config }).catch(() => undefined)
  data.backups = listStorageBackups().slice(-5).reverse()
  data.recoveryDrills = listStorageRecoveryDrills({ limit: 5 })

  // Source 1: durable Gateway work queue.
  try {
    const work = options.workStateFile ? workQueueSnapshotFromFile(options.workStateFile) : getWorkQueueSnapshot()
    workState = work.state
    data.tasks = work.tasks
    data.roadmaps = work.state.roadmaps
    data.projectBindings = work.state.projectBindings
    data.completionProposals = work.state.completionProposals
    Object.assign(data.workGraphSourceAvailable, { tasks: true, roadmaps: true, projectBindings: true, runs: true, completionProposals: true })
    try {
      data.humanGates = listHumanGates({ status: 'open' }, options.workStateFile)
      data.workGraphSourceAvailable.humanGates = true
    } catch { data.humanGates = [] }
    try {
      data.promotionScorecards = listPromotionScorecards({}, options.workStateFile)
      data.promotionDecisions = listPromotionDecisions({}, options.workStateFile)
      data.promotionEvidenceSourceAvailable = true
    } catch {
      data.promotionScorecards = []
      data.promotionDecisions = []
      data.promotionEvidenceSourceAvailable = false
    }
    data.runs = work.state.runs.slice(-20)
    data.alphaHealthRuns = work.state.runs
    data.environments = listWorkEnvironments({}, work.state)
    data.throughput = buildRunThroughput(work.state.runs)
    data.supervisorObservability = buildSupervisorObservability(work.state)
    data.supervisors = data.supervisorObservability.supervisors
    data.workGraphSourceAvailable.supervisors = true
    data.governance = buildGovernanceReport(work.state, config)
    data.attention = buildNeedsAttentionReport({ state: work.state, config })
    data.teamAssignments = listTeamTaskAssignments({ limit: 100 }, options.workStateFile)
    data.workGraphSourceAvailable.teamAssignments = true
    recordSourceDiagnostic(data, 'work_graph', true, 'Gateway durable work graph loaded.')
  } catch (err: any) {
    recordSourceDiagnostic(data, 'work_graph', false, err?.message || String(err))
  }

  // Source 2: OpenCode session list for Gateway session status and Web links.
  try {
    const sessions = await getCachedGatewaySessions(config.opencodeUrl, workDirectories(workState))
    data.sessions = normalizeGatewaySessions(sessions, config, workState)
    data.workGraphSourceAvailable.sessions = true
    data.counts = {
      total: data.sessions.length,
      running: data.sessions.filter((session: any) => session.status === 'running').length,
      completed: data.sessions.filter((session: any) => session.status === 'done').length,
    }
    recordSourceDiagnostic(data, 'opencode_sessions', true, 'OpenCode Gateway sessions loaded.')
  } catch (err: any) {
    recordSourceDiagnostic(data, 'opencode_sessions', false, err?.message || String(err))
  }

  // Source 3: Scheduler profiles. Sessions are OpenCode-native and may be many.
  data.profiles = config.profiles
  data.agentTeams = buildAgentTeamSummary(config, workState)
  data.agentCatalog = buildAgentCatalog({ config, workState })

  // Source 3b: Channel provider, binding, and sync bridge summary. Counts only; credentials stay server-side.
  try {
    const links = workState
      ? channelBindingsFromProjectBindings(data.projectBindings || [])
      : listChannelSessions({}, options.workStateFile)
    data.channels = buildChannelSummary(config, links, getChannelSyncSummary({ stateFile: options.channelSyncStateFile }), data.projectBindings || [])
    data.workGraphSourceAvailable.channels = true
  } catch {
    data.channels = buildChannelSummary(config, [], { active: false, deliveriesTracked: 0, pendingInbound: 0 }, data.projectBindings || [])
    recordSourceDiagnostic(data, 'channels', false, 'Channel summary unavailable; rendered with empty provider state.')
  }

  if (workState) data.capacity = buildCapacityReport({ state: workState, config, channelSync: data.channels?.sync, humanGates: data.humanGates })

  try {
    if (!workState) throw new Error('work graph unavailable')
    const snapshot = buildObservabilitySnapshot({ state: workState })
    data.traceCorrelation = snapshot.trace
    data.observabilitySlo = snapshot.slo
    data.supportOperations = snapshot.support
    data.workGraphSourceAvailable.observability = true
    recordSourceDiagnostic(data, 'observability', true, 'Trace correlation and SLO snapshot loaded.')
  } catch (err: any) {
    data.traceCorrelation = undefined
    data.observabilitySlo = []
    data.supportOperations = undefined
    data.workGraphSourceAvailable.observability = false
    recordSourceDiagnostic(data, 'observability', false, err?.message || String(err))
  }

  // Source 4: Events from wakeup
  try {
    const wake = await import('./wakeup.js')
    data.events = wake.getQueuedEvents().slice(-20)
  } catch {}

  // Source 5: Execution history
  try {
    const execFile = path.join(getConfigDir(), 'observability', 'executions.jsonl')
    if (fs.existsSync(execFile)) {
      const lines = fs.readFileSync(execFile, 'utf-8').split('\n').filter(Boolean)
      data.executions = lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean).slice(-10).reverse()
    }
  } catch {}

  // Source 6: OpenCode-native requests that need a human decision.
  try {
    const { questions, permissions, available } = await getCachedRequests()
    data.questions = questions
    data.permissions = permissions
    data.requestSourceAvailable = available
    data.workGraphSourceAvailable.requests = available
    if (!available) recordSourceDiagnostic(data, 'opencode_requests', false, 'OpenCode questions or permissions source unavailable.')
    data.attention = buildNeedsAttentionReport({ state: workState, questions, permissions, config })
    const alerts = await runAlertEngine({ questions, permissions }).catch(() => undefined)
    data.alerts = alerts?.active || []
    data.workGraphSourceAvailable.alerts = Boolean(alerts)
    data.metrics = alerts?.metrics
    if (workState && data.supportOperations) {
      const snapshot = buildObservabilitySnapshot({ state: workState, alerts: data.alerts })
      data.traceCorrelation = snapshot.trace
      data.observabilitySlo = snapshot.slo
      data.supportOperations = snapshot.support
    }
  } catch (err: any) {
    recordSourceDiagnostic(data, 'opencode_requests', false, err?.message || String(err))
  }

  data.alphaHealth = buildAlphaHealthSummary({
    serviceHealth: data.serviceHealth,
    readiness: data.readiness,
    heartbeat: data.heartbeat,
    scheduler: data.scheduler,
    channels: data.channels,
    humanGates: data.humanGates,
    questions: data.questions,
    permissions: data.permissions,
    requestSourceAvailable: data.requestSourceAvailable,
    completionProposals: data.completionProposals,
    promotionScorecards: data.promotionScorecards,
    backups: data.backups,
    recoveryDrills: data.recoveryDrills,
    runs: data.alphaHealthRuns || data.runs,
    tasks: data.tasks,
    supervisors: data.supervisors,
    alerts: data.alerts,
  })
  data.operationsCockpit = buildOperationsCockpit({
    readiness: data.readiness,
    channels: data.channels,
    operator: data.operator,
    sourceDiagnostics: data.sourceDiagnostics,
  })

  return data
}

function recordSourceDiagnostic(data: Pick<MissionDataContract, 'sourceDiagnostics'>, source: string, available: boolean, summary: string): void {
  const rows = Array.isArray(data.sourceDiagnostics) ? data.sourceDiagnostics : []
  rows.push({
    source,
    available,
    summary: redactSensitiveText(String(summary || '').substring(0, 500)),
  })
  data.sourceDiagnostics = rows
}

function workQueueSnapshotFromFile(filePath: string): { state: WorkState; tasks: any[]; counts: ReturnType<typeof summarizeWorkTasks> } {
  const state = loadWorkState(filePath)
  const tasks = listWorkTaskViews(state)
  return { state, tasks, counts: summarizeWorkTasks(tasks) }
}

export function parseGatewaySessionRows(rows: unknown): MissionSessionSummary[] {
  if (!Array.isArray(rows)) return []
  const sessions: MissionSessionSummary[] = []
  for (const row of rows) {
    const parsed = MissionSessionSummarySchema.safeParse(row)
    // Drop malformed rows (e.g. an upstream field rename that voids the required
    // `id`) instead of pushing a half-blank object downstream.
    if (parsed.success) sessions.push(parsed.data)
  }
  return sessions
}

async function getCachedGatewaySessions(opencodeUrl: string, directories: string[] = []): Promise<MissionSessionSummary[]> {
  const key = safeOpenCodeBaseUrl(opencodeUrl).toString().replace(/\/$/, '')
  const directoryKey = [...new Set(directories)].sort().join('|')
  const now = Date.now()
  const cacheKey = `${key}|${directoryKey}`
  if (sessionCache && sessionCache.key === cacheKey && sessionCache.expiresAt > now) return sessionCache.sessions
  const sessions: MissionSessionSummary[] = []
  for (const directory of [undefined, ...new Set(directories)]) {
    const url = openCodeEndpointUrl(opencodeUrl, 'session')
    if (directory) url.searchParams.set('directory', directory)
    const rows = await fetchWithTimeout(url, {}, 5_000, 'OpenCode session list').then(r => r.json())
    sessions.push(...parseGatewaySessionRows(rows))
  }
  sessionCache = { key: cacheKey, expiresAt: now + SESSION_CACHE_TTL_MS, sessions: dedupeSessions(sessions) }
  return sessionCache.sessions
}

function normalizeGatewaySessions(sessions: MissionSessionSummary[], config: GatewayConfig, workState?: WorkState): MissionGatewaySessionSummary[] {
  const activeRunSessionIds = new Set((workState?.runs || []).filter(run => run.status === 'running').map(run => run.sessionId))
  return sessions.filter(s => (s.title || '').startsWith('GW:'))
    .sort((a, b) => (b.time?.created || 0) - (a.time?.created || 0))
    .map(s => {
      const hasRun = (s.tokens?.input || 0) > 0 || (s.cost || 0) > 0
      const age = Date.now() - (s.time?.created || 0)
      const schedulerSession = /\[[a-zA-Z0-9_-]+\]\s*$/.test(String(s.title || ''))
      const isStale = !hasRun && (age > 600000 || (schedulerSession && !activeRunSessionIds.has(s.id)))
      if (isStale) return undefined
      const status: MissionGatewaySessionSummary['status'] = activeRunSessionIds.has(s.id) ? 'running' : hasRun ? 'done' : 'running'
      return {
        id: s.id,
        title: (s.title || '').replace('GW:', '').trim(),
        status,
        cost: s.cost || 0,
        tokens: typeof s.tokens === 'object' && s.tokens !== null ? s.tokens : {},
        model: typeof s.model === 'object' && s.model !== null ? s.model : {},
        agent: s.agent || '?',
        created: s.time?.created || 0,
        webUrl: opencodeSessionWebUrl(config.opencodeUrl, s),
      }
    }).filter((w): w is MissionGatewaySessionSummary => Boolean(w))
}

function dedupeSessions(sessions: MissionSessionSummary[]): MissionSessionSummary[] {
  const byId = new Map<string, MissionSessionSummary>()
  for (const session of sessions) {
    if (session.id) byId.set(session.id, session)
  }
  return [...byId.values()]
}

function workDirectories(workState?: WorkState): string[] {
  const dirs = new Set<string>()
  for (const task of workState?.tasks || []) {
    const dir = taskWorkdir(task)
    if (dir) dirs.add(dir)
  }
  for (const run of workState?.runs || []) {
    if (run.environment?.workdir) dirs.add(run.environment.workdir)
  }
  return [...dirs]
}

function taskWorkdir(task: any): string | undefined {
  const spec = task?.qualitySpec
  const candidates = [...(spec?.systemsTouched || []), ...(spec?.constraints || []), ...(spec?.requiredArtifacts || []), task?.note || '', task?.description || '']
  for (const value of candidates) {
    for (const line of String(value).split(/\r?\n/)) {
      const candidate = line.match(/^\s*(?:workdir|working directory|checkout|directory)\s*:\s*(.+?)\s*$/i)?.[1]?.trim()
      if (candidate && path.isAbsolute(candidate)) return canonicalWorkdir(candidate)
    }
    const inline = String(value).match(/\b(?:workdir|checkout)=([^\s,;]+)/i)?.[1]
    if (inline && path.isAbsolute(inline)) return canonicalWorkdir(inline)
  }
  return undefined
}

function canonicalWorkdir(directory: string): string {
  try { return fs.realpathSync(directory) } catch { return path.resolve(directory) }
}

async function getCachedRequests(): Promise<{ questions: any[]; permissions: any[]; available: boolean }> {
  const now = Date.now()
  if (requestCache && requestCache.expiresAt > now) return requestCache
  const requests = await import('./opencode-requests.js')
  const [questionResult, permissionResult] = await Promise.allSettled([
    requests.listPendingQuestions(),
    requests.listPendingPermissions(),
  ])
  const questions = questionResult.status === 'fulfilled' ? questionResult.value : []
  const permissions = permissionResult.status === 'fulfilled' ? permissionResult.value : []
  const available = questionResult.status === 'fulfilled' && permissionResult.status === 'fulfilled'
  requestCache = { expiresAt: now + REQUEST_CACHE_TTL_MS, questions, permissions, available }
  return requestCache
}


export function buildRunThroughput(runs: RunRecord[], options: { now?: number; days?: number } = {}): RunThroughputPoint[] {
  const days = Math.max(1, Math.min(Math.floor(options.days || 14), 60))
  const today = startOfLocalDay(new Date(options.now || Date.now()))
  const start = addDays(today, 1 - days)
  const end = addDays(today, 1).getTime()
  const points = new Map<string, RunThroughputPoint>()
  for (let i = 0; i < days; i++) {
    const date = dateInput(addDays(start, i))
    points.set(date, { date, done: 0, cost: 0 })
  }
  for (const run of runs || []) {
    const completedAt = Date.parse(run.completedAt || '')
    if (!Number.isFinite(completedAt) || completedAt < start.getTime() || completedAt >= end) continue
    const date = dateInput(new Date(completedAt))
    const point = points.get(date)
    if (!point) continue
    if (run.status === 'passed') point.done += 1
    point.cost += Number(run.costUsd || 0)
  }
  return [...points.values()]
}

export function buildChannelSummary(config: GatewayConfig, links: ChannelBindingRecord[] = [], sync: ChannelSyncSummary = { active: false, deliveriesTracked: 0, pendingInbound: 0 }, projectBindings: ProjectBindingRecord[] = []): MissionChannelSummary {
  const registryBindings = dedupeChannelBindingRecords([...links, ...channelBindingsFromProjectBindings(projectBindings)])
  const connectorRegistry = buildChannelConnectorRegistry({ config, bindings: registryBindings as any })
  const nativeControlCoverage = channelActionProviderControlSummaries()
  return {
    providers: ['telegram', 'whatsapp', 'discord'].map(provider => buildChannelProviderSummary(provider as 'telegram' | 'whatsapp' | 'discord', config, links, projectBindings)),
    sync: {
      active: sync.active,
      syncEnabled: config.channelSync.enabled,
      intervalMs: config.channelSync.intervalMs,
      includeUserMessages: config.channelSync.includeUserMessages,
      lastSyncAt: sync.lastSyncAt,
      deliveriesTracked: sync.deliveriesTracked,
      pendingInbound: sync.pendingInbound,
      outbox: sync.outbox,
    },
    links,
    connectorRegistry,
    actionParity: channelActionParityMatrix(),
    nativeControlCoverage,
  }
}

function dedupeChannelBindingRecords(bindings: ChannelBindingRecord[]): ChannelBindingRecord[] {
  const seen = new Set<string>()
  return bindings.filter(binding => {
    const key = channelBindingIdentityKey(binding)
    if (!key) return true
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function channelBindingIdentityKey(binding: Pick<ChannelBindingRecord, 'provider' | 'chatId' | 'threadId' | 'sessionId'>): string {
  if (!binding.provider || !binding.chatId || !binding.sessionId) return ''
  return `${binding.provider}:${binding.chatId}:${binding.threadId || ''}:${binding.sessionId}`
}

function channelBindingsFromProjectBindings(projectBindings: ProjectBindingRecord[]): ChannelBindingRecord[] {
  return projectBindings
    .filter(binding => binding.provider && binding.chatId && binding.sessionId)
    .map(binding => ({
      provider: String(binding.provider),
      chatId: String(binding.chatId),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
      sessionId: binding.sessionId,
      mode: 'roadmap' as const,
      roadmapId: binding.roadmapId,
      title: binding.title || binding.alias,
      createdAt: binding.createdAt,
      updatedAt: binding.updatedAt,
    }))
}

export function buildAgentTeamSummary(config: GatewayConfig, workState?: Pick<WorkState, 'roadmaps' | 'tasks' | 'runs'>): MissionAgentTeamSummary {
  const agentTeams = config.agentTeams || {}
  const profiles = config.profiles || {}
  const roadmaps = workState?.roadmaps || []
  const tasks = workState?.tasks || []
  const runs = workState?.runs || []
  const references = new Map<string, { roadmapIds: Set<string>; taskIds: Set<string>; activeTaskIds: Set<string>; runIds: Set<string> }>()
  const invalidReferences: MissionAgentTeamSummary['invalidReferences'] = []

  const ensureRefs = (name: string) => {
    let row = references.get(name)
    if (!row) {
      row = { roadmapIds: new Set(), taskIds: new Set(), activeTaskIds: new Set(), runIds: new Set() }
      references.set(name, row)
    }
    return row
  }

  const roadmapTeams = new Map<string, string>()
  for (const roadmap of roadmaps) {
    if (!roadmap.agentTeam) continue
    roadmapTeams.set(roadmap.id, roadmap.agentTeam)
    if (!agentTeams[roadmap.agentTeam]) {
      invalidReferences.push({ kind: 'roadmap', id: roadmap.id, title: roadmap.title, agentTeam: roadmap.agentTeam, reason: 'agent team is not configured' })
      continue
    }
    ensureRefs(roadmap.agentTeam).roadmapIds.add(roadmap.id)
  }

  for (const task of tasks) {
    const explicitTeam = task.agentTeam
    const inheritedTeam = explicitTeam ? undefined : roadmapTeams.get(task.roadmapId)
    const teamName = explicitTeam || inheritedTeam
    if (!teamName) continue
    if (!agentTeams[teamName]) {
      if (explicitTeam) invalidReferences.push({ kind: 'task', id: task.id, title: task.title, agentTeam: teamName, reason: 'agent team is not configured' })
      continue
    }
    const refs = ensureRefs(teamName)
    refs.taskIds.add(task.id)
    if (task.status === 'pending' || task.status === 'running' || task.status === 'blocked' || task.status === 'paused') refs.activeTaskIds.add(task.id)
  }

  for (const run of runs) {
    if (!run.agentTeam) continue
    if (!agentTeams[run.agentTeam]) {
      invalidReferences.push({ kind: 'run', id: run.id, agentTeam: run.agentTeam, reason: 'run references an agent team that is no longer configured' })
      continue
    }
    ensureRefs(run.agentTeam).runIds.add(run.id)
  }

  const teams = Object.entries(agentTeams).sort(([a], [b]) => a.localeCompare(b)).map(([name, team]) => {
    const warnings = agentTeamWarnings(name, team, profiles)
    const refs = references.get(name)
    return {
      name,
      description: team.description,
      version: team.version,
      promotionState: team.promotionState,
      revision: team.revision,
      health: warnings.length ? 'warning' as const : 'ok' as const,
      warnings,
      roles: Object.entries(team.roles || {}).sort(([a], [b]) => stageSort(a, b)).map(([stage, profileName]) => {
        const profile = profiles[profileName]
        return {
          stage,
          profile: profileName,
          agent: profile?.agent,
          model: profile ? `${profile.model.providerID}/${profile.model.modelID}` : undefined,
          role: profile?.role,
        }
      }),
      capabilityRequirements: Object.entries(team.capabilityRequirements || {}).sort(([a], [b]) => stageSort(a, b)).map(([stage, capabilities]) => ({ stage, capabilities })),
      qualitySpecDefaultKeys: Object.keys(team.qualitySpecDefaults || {}).sort(),
      references: {
        roadmaps: refs?.roadmapIds.size || 0,
        tasks: refs?.taskIds.size || 0,
        activeTasks: refs?.activeTaskIds.size || 0,
        recentRuns: refs?.runIds.size || 0,
      },
    }
  })

  const recentRuns = runs.slice(-20).reverse().map(run => ({
    id: run.id,
    taskId: run.taskId,
    stage: run.stage,
    status: run.status,
    agentTeam: run.agentTeam,
    agentTeamVersion: run.agentTeamVersion,
    resolvedProfile: run.resolvedProfile,
    resolvedAgent: run.resolvedAgent,
    profile: run.profile,
    sessionId: run.sessionId,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  }))

  return {
    totals: {
      teams: teams.length,
      referencedTeams: teams.filter(team => team.references.roadmaps || team.references.tasks || team.references.recentRuns).length,
      invalidReferences: invalidReferences.length,
      activeTasks: teams.reduce((sum, team) => sum + team.references.activeTasks, 0),
      recentRuns: recentRuns.length,
    },
    teams,
    invalidReferences,
    recentRuns,
  }
}

function agentTeamWarnings(name: string, team: AgentTeamConfig, profiles: Record<string, AgentProfile>): string[] {
  const warnings: string[] = []
  const stages = new Set([...Object.keys(team.roles || {}), ...Object.keys(team.capabilityRequirements || {})])
  if (!stages.size) stages.add('default')
  for (const stage of [...stages].sort(stageSort)) {
    const profileName = team.roles[stage] || team.roles['default']
    const profile = profileName ? profiles[profileName] : undefined
    if (!profileName || !profile) {
      warnings.push(`${stage} references missing profile ${profileName || '(none)'}`)
      continue
    }
    const required = stage === 'default'
      ? (team.capabilityRequirements['default'] || [])
      : [...(team.capabilityRequirements['default'] || []), ...(team.capabilityRequirements[stage] || [])]
    const missing = required.filter(capability => !profileHasCapability(profile, capability))
    if (missing.length) warnings.push(`${stage} profile ${profileName} lacks ${missing.join(', ')}`)
  }
  if (name === 'default' && !team.description) warnings.push('default team has no description')
  return warnings
}

function profileHasCapability(profile: AgentProfile, capability: string): boolean {
  if (profile.agent === capability) return true
  if ((profile.skills || []).includes(capability)) return true
  if ((profile.capabilities || []).includes(capability)) return true
  if ((profile.tools || []).includes(capability)) return true
  if ((profile.mcpServers || []).includes(capability)) return true
  const permission = profile.permission || {}
  return permission[capability] === 'allow' || permission[`${capability}_`] === 'allow' || permission[`${capability}_*`] === 'allow'
}

function stageSort(a: string, b: string): number {
  if (a === b) return 0
  if (a === 'default') return -1
  if (b === 'default') return 1
  return a.localeCompare(b)
}

function buildChannelProviderSummary(provider: 'telegram' | 'whatsapp' | 'discord', config: GatewayConfig, links: ChannelBindingRecord[], projectBindings: ProjectBindingRecord[]): MissionChannelSummary['providers'][number] {
  const configured = providerConfigured(provider, config)
  const trusted = hasChannelAllowlist(provider, config) || allowsAllChannelTargets(provider, config)
  const unsafe = allowsAllChannelTargets(provider, config)
  const missingSignature = provider === 'whatsapp' && configured && !whatsAppAppSecretConfigured(config)
  const missingDiscordBotToken = provider === 'discord' && configured && discordAlphaEnabled(config) && !discordBotTokenConfigured(config)
  const missingDiscordPublicKey = provider === 'discord' && configured && discordAlphaEnabled(config) && !discordPublicKeyConfigured(config)
  const enabled = provider === 'discord'
    ? configured && discordAlphaEnabled(config) && discordBotTokenConfigured(config) && discordPublicKeyConfigured(config) && trusted
    : configured && trusted
  const health: 'ok' | 'degraded' | 'down' = !configured ? 'down' : (!trusted || missingSignature || unsafe || missingDiscordBotToken || missingDiscordPublicKey) ? 'degraded' : 'ok'
  return {
    provider,
    configured,
    enabled,
    bindings: countProviderBindings(provider, links, projectBindings),
    health,
    note: channelProviderNote(provider, configured, trusted, unsafe, missingSignature, missingDiscordBotToken, missingDiscordPublicKey, enabled),
  }
}

function providerConfigured(provider: 'telegram' | 'whatsapp' | 'discord', config: GatewayConfig): boolean {
  if (provider === 'telegram') return Boolean(process.env['TELEGRAM_BOT_TOKEN'] || config.channels.telegram?.botToken)
  if (provider === 'discord') return isChannelProviderConfigured('discord', config)
  const cfg = config.channels.whatsapp || {}
  return Boolean(
    (process.env['WHATSAPP_ACCESS_TOKEN'] || cfg.accessToken) &&
    (process.env['WHATSAPP_PHONE_NUMBER_ID'] || cfg.phoneNumberId) &&
    (process.env['WHATSAPP_VERIFY_TOKEN'] || cfg.verifyToken)
  )
}

function whatsAppAppSecretConfigured(config: GatewayConfig): boolean {
  return Boolean(process.env['WHATSAPP_APP_SECRET'] || config.channels.whatsapp?.appSecret)
}

function discordAlphaEnabled(config: GatewayConfig): boolean {
  return process.env['OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED'] === 'true' || config.channels.discord?.enabled === true
}

function discordPublicKeyConfigured(config: GatewayConfig): boolean {
  return Boolean(process.env['DISCORD_PUBLIC_KEY'] || config.channels.discord?.publicKey)
}

function discordBotTokenConfigured(config: GatewayConfig): boolean {
  return Boolean(process.env['DISCORD_BOT_TOKEN'] || config.channels.discord?.botToken)
}

function countProviderBindings(provider: 'telegram' | 'whatsapp' | 'discord', links: ChannelBindingRecord[], projectBindings: ProjectBindingRecord[]): number {
  const projected = channelBindingsFromProjectBindings(projectBindings)
  return dedupeChannelBindingRecords([...links, ...projected]).filter(binding => binding.provider === provider).length
}

function channelProviderNote(provider: 'telegram' | 'whatsapp' | 'discord', configured: boolean, trusted: boolean, unsafe: boolean, missingSignature: boolean, missingDiscordBotToken = false, missingDiscordPublicKey = false, enabled = false): string {
  if (!configured) return `${provider} credentials are not configured; adapter disabled.`
  if (provider === 'discord' && !enabled) {
    if (missingDiscordBotToken) return 'Discord alpha is enabled, but botToken is missing; outbound notifications stay disabled.'
    if (missingDiscordPublicKey) return 'Discord alpha is enabled, but publicKey is missing; signed interaction webhooks are rejected.'
    if (!trusted) return 'Discord alpha is configured, but no channel allowlist is configured; inbound targets fail closed.'
    return 'Discord alpha is configured but disabled; set channels.discord.enabled=true or OPENCODE_GATEWAY_DISCORD_ALPHA_ENABLED=true.'
  }
  if (!trusted) return 'Credentials are present, but no channel allowlist is configured; inbound targets fail closed.'
  if (missingSignature) return 'WhatsApp credentials are present, but appSecret is missing; inbound POST webhooks are rejected.'
  if (missingDiscordPublicKey) return 'Discord alpha is enabled, but publicKey is missing; signed interaction webhooks are rejected.'
  if (unsafe) return 'Unsafe allow-all override is enabled; rotate to explicit allowlists before production use.'
  return provider === 'discord' ? 'Discord alpha has credentials, signed interactions, and explicit allowlist configured.' : 'Credentials and explicit allowlist are configured.'
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function dateInput(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// ---------------------------------------------------------------------------
// Mission Control drill-down read models
//
// Read-only, bounded reads that back the dashboard's ?view=roadmap|task|run
// drill-down pages. They live in the Mission Control read-model module so the
// dashboard renderer consumes typed contracts instead of importing the mutable
// work-store directly (module-boundary: dashboard reads read-models only).
// ---------------------------------------------------------------------------

/** Re-exported record contracts used by dashboard drill-down renderers. */
export type { RunRecord, WorkDependencyRecord, RoadmapRecord, WorkTaskRecord, WorkTaskView, HumanGateRecord } from './work-store.js'

export interface RoadmapDetailData {
  roadmap?: RoadmapRecord
  tasks: WorkTaskRecord[]
  dependencies: WorkDependencyRecord[]
  runs: RunRecord[]
}

/** Roadmap drill-down: its roadmap row, tasks, intra-roadmap dependencies, and recent runs. */
export function getRoadmapDetailData(id: string): RoadmapDetailData {
  // Bounded work: the runs shown come from the targeted getRunsForRoadmap query
  // below, so only the live run window needs materializing (roadmaps, tasks, and
  // dependencies are unaffected by runsScope). Avoids loading all run history.
  const state = loadWorkStateReadOnly(undefined, { runsScope: 'live' })
  const roadmap = state.roadmaps.find(row => row.id === id)
  const tasks = state.tasks.filter(task => task.roadmapId === id)
  const taskIds = new Set(tasks.map(task => task.id))
  const dependencies = (state.dependencies || []).filter(dep => taskIds.has(dep.taskId))
  const runs = roadmap ? getRunsForRoadmap(id, { limit: 100 }) : []
  return { roadmap, tasks, dependencies, runs }
}

export interface TaskDependencyRef {
  id: string
  title?: string
  status?: string
  type?: string
}

export interface TaskDetailData {
  task?: WorkTaskView
  roadmap?: RoadmapRecord
  dependencies: TaskDependencyRef[]
  dependents: TaskDependencyRef[]
  gates: HumanGateRecord[]
  runs: RunRecord[]
}

/** Task drill-down: the task view, its roadmap, upstream deps, downstream dependents, gates, and runs. */
export function getTaskDetailData(id: string): TaskDetailData {
  // Bounded work: the task's run history shown comes from the targeted
  // getRunsForTask query below; readiness/activeRun/lastRun on the task view only
  // need the live window (active runs and the recent terminal slice are always in
  // it), so the full run table is never materialized for a single-task drill-down.
  const state = loadWorkStateReadOnly(undefined, { runsScope: 'live' })
  const task = listWorkTaskViews(state).find(row => row.id === id)
  if (!task) return { task: undefined, dependencies: [], dependents: [], gates: [], runs: [] }
  const taskById = new Map(state.tasks.map(row => [row.id, row]))
  const roadmap = state.roadmaps.find(row => row.id === task.roadmapId)
  const dependencies: TaskDependencyRef[] = (task.dependencies || []).map(dep => {
    const upstream = taskById.get(dep.dependsOnTaskId)
    return { id: dep.dependsOnTaskId, title: upstream?.title, status: upstream?.status, type: dep.type }
  })
  const dependents: TaskDependencyRef[] = (state.dependencies || [])
    .filter(dep => dep.dependsOnTaskId === id)
    .map(dep => {
      const downstream = taskById.get(dep.taskId)
      return { id: dep.taskId, title: downstream?.title, status: downstream?.status }
    })
  const gates = listHumanGatesReadOnly({ taskId: id })
  const runs = getRunsForTask(id, { limit: 100 })
  return { task, roadmap, dependencies, dependents, gates, runs }
}

export interface RunDetailData {
  run?: RunRecord
}

/** Run drill-down: a single run by id (or bound session id). */
export function getRunDetailData(id: string): RunDetailData {
  // Read-only: use the read-only run getter so a `?view=run&id=...` drill-down
  // never creates the database or schema as a side effect of a read view.
  return { run: id ? getRunReadOnly(id) : undefined }
}
