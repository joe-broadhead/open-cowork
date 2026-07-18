import type { ObservabilitySloResult, TraceCorrelationIndex } from './observability-contract.js'
import { formatTaskCounts, isActiveTaskStatus } from './task-summary.js'

export type MissionControlSourceState = 'loading' | 'ready' | 'empty' | 'partial' | 'stale' | 'degraded' | 'missing' | 'blocked' | 'error'
export type MissionControlSourceSeverity = 'ok' | 'info' | 'warning' | 'critical'

export interface MissionControlSourceContract {
  key: string
  label: string
  view: string
  route: string
  available: boolean
  state: MissionControlSourceState
  severity: MissionControlSourceSeverity
  searchable: boolean
  total: number
  matched: number
  shown: number
  limit: number
  offset: number
  hasMore: boolean
  truncated: boolean
  search?: string
  diagnostic?: string
  nextAction: string
  checkedAt?: string
  freshnessMs?: number
  ageMs?: number
}

export interface MissionControlSourceSummaryItem {
  key: string
  label: string
  route: string
  state: MissionControlSourceState
  severity: MissionControlSourceSeverity
  available: boolean
  diagnostic?: string
  nextAction: string
}

export interface MissionControlSourceSummary {
  status: MissionControlSourceState
  severity: MissionControlSourceSeverity
  summary: string
  counts: Record<MissionControlSourceState, number>
  items: MissionControlSourceSummaryItem[]
}

export type MissionControlSourceOperatorActionKind = 'inspect' | 'paginate' | 'refresh' | 'repair' | 'wait' | 'none'

export interface MissionControlSourceOperatorAction {
  kind: MissionControlSourceOperatorActionKind
  available: boolean
  label: string
  route?: string
  reason: string
}

export interface MissionControlSourceStateViewModelSource {
  key: string
  label: string
  view: string
  route: string
  state: MissionControlSourceState
  severity: MissionControlSourceSeverity
  available: boolean
  searchable: boolean
  totals: {
    total: number
    matched: number
    shown: number
    limit: number
    offset: number
    hasMore: boolean
    truncated: boolean
    highVolume: boolean
  }
  search?: string
  diagnostic?: string
  nextAction: string
  operatorAction: MissionControlSourceOperatorAction
  freshness: {
    checkedAt?: string
    freshnessMs?: number
    ageMs?: number
    state: 'fresh' | 'stale' | 'unknown'
  }
  evidenceLinks: string[]
}

export interface MissionControlSourceStateViewModelInput {
  sourceContracts: MissionControlSourceContract[]
  generatedAt?: string
  highVolumeThreshold?: number
  evidenceLinks?: Partial<Record<string | 'all', string[]>>
}

export interface MissionControlSourceStateViewModel {
  schemaVersion: 1
  mode: 'mission_control_source_state_view_model'
  generatedAt: string
  status: MissionControlSourceState
  severity: MissionControlSourceSeverity
  releaseClaimBoundary: 'local_beta_read_model_only_no_hosted_arbitrary_scale_or_unattended_claim'
  sourceSummary: MissionControlSourceSummary
  counts: {
    sources: number
    totalRows: number
    matchedRows: number
    shownRows: number
    truncatedSources: number
    highVolumeSources: number
    unavailableSources: number
    staleSources: number
    blockedOrErrorSources: number
  }
  window: {
    bounded: boolean
    deterministicOrdering: 'preserve_contract_order'
    sourceKeys: string[]
    highVolumeThreshold: number
    largestConfiguredLimit: number
  }
  actionAvailability: Record<MissionControlSourceOperatorActionKind, number>
  redaction: 'support_safe_ids_routes_actions_only'
  sources: MissionControlSourceStateViewModelSource[]
  evidenceLinks: string[]
  attention: string[]
  acceptance: {
    deterministicOrdering: boolean
    boundedWindows: boolean
    degradedSourcesVisible: boolean
    actionAvailabilityRecorded: boolean
    evidenceLinksSupportSafe: boolean
    noReleaseClaimExpansion: true
  }
  unsupportedClaims: string[]
  issues: Array<{ code: string; severity: 'critical'; summary: string }>
}

export type MissionControlDataPlaneStatus = 'ready' | 'bounded' | 'degraded' | 'blocked'
export type MissionControlDataPlaneConsumer = 'dashboard' | 'mcp' | 'support' | 'cli'

export interface MissionControlDataPlaneConsumerContract {
  consumer: MissionControlDataPlaneConsumer
  truthVocabulary: 'mission_control_source_contracts'
  readOnly: true
  redaction: 'support_safe'
  summary: string
}

export interface MissionControlDataPlaneV2 {
  schemaVersion: 1
  mode: 'm41_mission_control_data_plane_v2'
  generatedAt: string
  status: MissionControlDataPlaneStatus
  releaseClaimBoundary: 'local_beta_high_volume_read_model_only_no_hosted_or_unattended_claim'
  summary: string
  sourceSummary: MissionControlSourceSummary
  consumers: MissionControlDataPlaneConsumerContract[]
  windowTotals: {
    sources: number
    totalRows: number
    matchedRows: number
    shownRows: number
    truncatedSources: number
    unavailableSources: number
    staleSources: number
    blockedOrErrorSources: number
    largestConfiguredLimit: number
  }
  acceptance: {
    boundedWindows: boolean
    readOnlyProjection: true
    sharedTruthVocabulary: boolean
    supportSafeSummary: true
    noReleaseClaimExpansion: true
  }
  errors: string[]
  unsupportedClaims: string[]
}

export interface MissionControlDataPlaneInput {
  sourceContracts: MissionControlSourceContract[]
  consumers?: MissionControlDataPlaneConsumer[]
  generatedAt?: string
}

export interface MissionControlDashboardSummaryInput {
  health: MissionControlHealthContract
  taskData: MissionControlTaskDataContract
  sessions: MissionControlSessionDataContract
  questions: MissionControlRequestCollectionContract
  permissions: MissionControlRequestCollectionContract
  attention?: MissionControlAttentionContract
  environments?: MissionControlEnvironmentCollectionContract
  operationsCockpit?: OperationsCockpitSummary
  sourceContracts?: MissionControlSourceContract[]
}

export interface MissionControlHealthContract {
  status?: string
  scheduler?: {
    enabled?: boolean
    maxConcurrent?: number
    defaultPipeline?: string[]
  }
  components?: Array<{
    id?: string
    status?: string
    summary?: string
  }>
}

export interface MissionControlTaskRowContract {
  id?: string
  status?: string
  priority?: string
  title?: string
  description?: string
  agent?: string
  currentStage?: string
}

export interface MissionControlRoadmapRowContract {
  id?: string
  status?: string
  priority?: string
  title?: string
}

export interface MissionControlRunRowContract {
  id?: string
  status?: string
  sessionId?: string
}

export interface MissionControlTaskDataContract {
  counts?: Record<string, number>
  tasks?: MissionControlTaskRowContract[]
  roadmaps?: MissionControlRoadmapRowContract[]
  runs?: MissionControlRunRowContract[]
}

export interface MissionControlSessionRowContract {
  id?: string
  status?: string
}

export interface MissionControlSessionDataContract {
  sessions?: MissionControlSessionRowContract[]
  counts?: {
    running?: number
    total?: number
    completed?: number
  }
}

export interface MissionControlRequestCollectionContract {
  questions?: Array<{ id?: string }>
  permissions?: Array<{ id?: string }>
}

export interface MissionControlAttentionContract {
  attention?: {
    summary?: string
  }
}

export interface MissionControlEnvironmentCollectionContract {
  environments?: Array<{
    status?: string
    cleanup?: { state?: string }
  }>
}

export interface MissionControlDashboardContractValidation {
  schemaVersion: 1
  mode: 'mission_control_dashboard_input_contract'
  status: 'pass' | 'fail'
  requiredFields: string[]
  deterministicOrdering: 'preserve_source_order_filter_in_view_model'
  redaction: 'support_safe_ids_only'
  failures: Array<{ field: string; summary: string }>
}

export interface MissionControlDashboardSummaryIssue {
  id: string
  status: string
  priority: string
  title: string
  agent: string
  currentStage: string
}

export interface MissionControlDashboardSummaryInitiative {
  id: string
  status: string
  priority: string
  title: string
}

export interface MissionControlDashboardSummary {
  status: string
  scheduler: string
  taskCounts: string
  gatewaySessions: string
  environments?: string
  requests: string
  attention?: string
  operationsCockpit?: {
    status: OperationsCockpitStatus
    summary: string
    items: Array<{ id: string; status: OperationsCockpitStatus; nextAction: string }>
  }
  sources?: MissionControlSourceSummary
  sourceStateView?: MissionControlSourceStateViewModel
  activeIssues: MissionControlDashboardSummaryIssue[]
  initiatives: MissionControlDashboardSummaryInitiative[]
}

export type OperationsCockpitStatus =
  | 'ready'
  | 'attention'
  | 'blocked'
  | 'preview'
  | 'deferred'
  | 'stale'
  | 'unavailable'
  | 'unsupported'

export interface OperationsCockpitItem {
  id: string
  label: string
  status: OperationsCockpitStatus
  summary: string
  nextAction: string
  source: string
  command?: string
  route?: string
  claim?: string
  previewOnly?: boolean
  blockers: string[]
  unsupportedClaims: string[]
}

export interface OperationsCockpitSummary {
  mode: 'operations_cockpit'
  generatedAt: string
  status: OperationsCockpitStatus
  summary: string
  items: OperationsCockpitItem[]
  counts: Record<OperationsCockpitStatus, number>
  unsupportedClaims: string[]
  releaseClaimBoundary: string
}

export interface OperationsCockpitInput {
  readiness?: any
  channels?: any
  operator?: any
  sourceDiagnostics?: Array<{ source?: string; available?: boolean; summary?: string }>
  generatedAt?: string
}

export type MissionControlWindowKey =
  | 'tasks'
  | 'roadmaps'
  | 'projectBindings'
  | 'runs'
  | 'events'
  | 'sessions'
  | 'environments'
  | 'alerts'
  | 'channelBindings'
  | 'teamAssignments'
  | 'agentProfiles'
  | 'agentTeams'
  | 'evidence'
  | 'supervisors'
  | 'gates'
  | 'workGraphNodes'
  | 'workGraphEdges'

export interface MissionControlWindowOptions {
  limit?: number
  offset?: number
  search?: string
}

export type MissionControlWindowOptionMap = Partial<Record<MissionControlWindowKey | 'all', MissionControlWindowOptions>>

export interface MissionControlSourceStateInput {
  available?: boolean
  state?: MissionControlSourceState
  diagnostic?: string
  nextAction?: string
  checkedAt?: string
  freshnessMs?: number
  nowMs?: number
}

export type MissionControlSourceAvailabilityValue = boolean | MissionControlSourceStateInput

export type MissionControlSourceAvailability = Partial<Record<
  | MissionControlWindowKey
  | 'channels'
  | 'humanGates'
  | 'completionProposals'
  | 'requests'
  | 'observability',
  MissionControlSourceAvailabilityValue
>>

export interface MissionControlWindowSpec {
  label: string
  view: string
  route: string
  defaultLimit: number
  maxLimit: number
  searchable: boolean
}

export const MISSION_CONTROL_WINDOW_SPECS: Record<MissionControlWindowKey, MissionControlWindowSpec> = {
  tasks: { label: 'Issues', view: 'Pipeline / Work Graph', route: '/tasks', defaultLimit: 250, maxLimit: 500, searchable: true },
  roadmaps: { label: 'Initiatives', view: 'Pipeline / Work Graph', route: '/roadmaps', defaultLimit: 120, maxLimit: 250, searchable: true },
  projectBindings: { label: 'Project bindings', view: 'Channels / Work Graph', route: '/project-bindings', defaultLimit: 120, maxLimit: 250, searchable: true },
  runs: { label: 'Runs', view: 'Pipeline / Arena / Work Graph', route: '/runs', defaultLimit: 120, maxLimit: 500, searchable: true },
  events: { label: 'Events', view: 'Overview / Channels', route: '/events', defaultLimit: 200, maxLimit: 500, searchable: true },
  sessions: { label: 'Sessions', view: 'Overview / Channels / Work Graph', route: '/opencode/sessions', defaultLimit: 100, maxLimit: 250, searchable: true },
  environments: { label: 'Environments', view: 'Environments', route: '/environments', defaultLimit: 100, maxLimit: 250, searchable: true },
  alerts: { label: 'Alerts', view: 'Health / Work Graph', route: '/alerts', defaultLimit: 100, maxLimit: 250, searchable: true },
  channelBindings: { label: 'Channel bindings', view: 'Channels / Work Graph', route: '/channels/bindings', defaultLimit: 100, maxLimit: 250, searchable: true },
  teamAssignments: { label: 'Team assignments', view: 'Agent Factory / Work Graph', route: '/team-assignments', defaultLimit: 100, maxLimit: 250, searchable: true },
  agentProfiles: { label: 'Agent profiles', view: 'Agent Factory / Health', route: '/profiles', defaultLimit: 50, maxLimit: 100, searchable: true },
  agentTeams: { label: 'Agent teams', view: 'Agent Factory / Health', route: '/agent-teams', defaultLimit: 50, maxLimit: 100, searchable: true },
  evidence: { label: 'Evidence', view: 'Arena / Evidence', route: '/evidence/export', defaultLimit: 100, maxLimit: 250, searchable: true },
  supervisors: { label: 'Supervisors', view: 'Health / Work Graph', route: '/roadmap-supervisors', defaultLimit: 100, maxLimit: 250, searchable: true },
  gates: { label: 'Gates and requests', view: 'Health / Work Graph', route: '/human-gates and /opencode/requests', defaultLimit: 100, maxLimit: 250, searchable: true },
  workGraphNodes: { label: 'Work graph nodes', view: 'Work Graph', route: '#/work-graph', defaultLimit: 300, maxLimit: 600, searchable: true },
  workGraphEdges: { label: 'Work graph edges', view: 'Work Graph', route: '#/work-graph', defaultLimit: 300, maxLimit: 600, searchable: true },
}

const WINDOW_AVAILABILITY_KEYS: Partial<Record<MissionControlWindowKey, Array<keyof MissionControlSourceAvailability>>> = {
  tasks: ['tasks'],
  roadmaps: ['roadmaps'],
  projectBindings: ['projectBindings'],
  runs: ['runs'],
  events: ['events'],
  sessions: ['sessions'],
  environments: ['environments'],
  alerts: ['alerts'],
  channelBindings: ['channelBindings', 'channels'],
  teamAssignments: ['teamAssignments'],
  agentProfiles: ['agentProfiles'],
  agentTeams: ['agentTeams'],
  evidence: ['evidence'],
  supervisors: ['supervisors'],
  gates: ['gates', 'humanGates', 'completionProposals', 'requests'],
}

export function missionControlWindow<T>(
  key: MissionControlWindowKey,
  rows: T[],
  options: MissionControlWindowOptionMap = {},
  availability: boolean | MissionControlSourceStateInput = true,
): { rows: T[]; contract: MissionControlSourceContract } {
  const spec = MISSION_CONTROL_WINDOW_SPECS[key]
  const requested = options[key] || {}
  const globalSearch = options.all?.search
  const search = spec.searchable ? normalizeMissionControlSearch(requested.search ?? globalSearch) : undefined
  const rawRows = asArray(rows) as T[]
  const filtered = search ? rawRows.filter(row => missionControlSearchText(row).includes(search.toLowerCase())) : rawRows
  const limit = clampInteger(requested.limit, spec.defaultLimit, 1, spec.maxLimit)
  const offset = clampInteger(requested.offset, 0, 0, Math.max(0, filtered.length))
  const windowed = filtered.slice(offset, offset + limit)
  const hasMore = offset + limit < filtered.length
  const availabilityInput = normalizeSourceAvailability(availability)
  const available = availabilityInput.available
  const diagnostic = availabilityInput.diagnostic
  const truncated = windowed.length < filtered.length
  const state = sourceState({ available, explicit: availabilityInput.state, rawRows: rawRows.length, matched: filtered.length, truncated, checkedAt: availabilityInput.checkedAt, freshnessMs: availabilityInput.freshnessMs, nowMs: availabilityInput.nowMs })
  return {
    rows: windowed,
    contract: {
      key,
      label: spec.label,
      view: spec.view,
      route: spec.route,
      available,
      state,
      severity: sourceSeverity(state),
      searchable: spec.searchable,
      total: rawRows.length,
      matched: filtered.length,
      shown: windowed.length,
      limit,
      offset,
      hasMore,
      truncated,
      search: search || undefined,
      diagnostic: diagnostic || (available ? undefined : `${spec.label} unavailable from ${spec.route}`),
      nextAction: sourceNextAction({ label: spec.label, route: spec.route, view: spec.view, state, nextAction: availabilityInput.nextAction }),
      checkedAt: availabilityInput.checkedAt,
      freshnessMs: availabilityInput.freshnessMs,
      ageMs: sourceAgeMs(availabilityInput.checkedAt, availabilityInput.nowMs),
    },
  }
}

export function buildObservabilitySourceContract(
  trace: TraceCorrelationIndex | undefined,
  slo: ObservabilitySloResult[],
  options: MissionControlWindowOptionMap,
  availability: boolean | MissionControlSourceStateInput,
): MissionControlSourceContract {
  const rows = [
    trace ? { kind: 'traceRoot', id: trace.traceRootId, generatedAt: trace.generatedAt } : undefined,
    ...(trace?.tasks || []).map(row => ({ kind: 'taskTrace', ...row })),
    ...(trace?.runs || []).map(row => ({ kind: 'runTrace', ...row })),
    ...(trace?.channels || []).map(row => ({ kind: 'channelTrace', ...row })),
    ...slo.map(row => ({ kind: 'slo', id: row.id, status: row.status, summary: row.summary })),
  ].filter(Boolean)
  const availabilityInput = normalizeSourceAvailability(availability)
  const available = availabilityInput.available
  const diagnostic = availabilityInput.diagnostic
  const search = normalizeMissionControlSearch(options.all?.search)
  const matched = search ? rows.filter(row => missionControlSearchText(row).includes(search.toLowerCase())).length : rows.length
  const truncated = rows.length > 20
  const state = sourceState({ available, explicit: availabilityInput.state, rawRows: rows.length, matched, truncated, checkedAt: availabilityInput.checkedAt, freshnessMs: availabilityInput.freshnessMs, nowMs: availabilityInput.nowMs })
  return {
    key: 'observability',
    label: 'Trace and SLOs',
    view: 'Health',
    route: '/observability',
    available,
    state,
    severity: sourceSeverity(state),
    searchable: true,
    total: rows.length,
    matched,
    shown: Math.min(rows.length, 20),
    limit: 20,
    offset: 0,
    hasMore: rows.length > 20,
    truncated,
    search: search || undefined,
    diagnostic: diagnostic || (available ? undefined : 'Trace correlation and SLO source unavailable from /observability'),
    nextAction: sourceNextAction({ label: 'Trace and SLOs', route: '/observability', view: 'Health', state, nextAction: availabilityInput.nextAction }),
    checkedAt: availabilityInput.checkedAt,
    freshnessMs: availabilityInput.freshnessMs,
    ageMs: sourceAgeMs(availabilityInput.checkedAt, availabilityInput.nowMs),
  }
}

export function parseMissionControlWindowOptions(searchParams?: URLSearchParams): MissionControlWindowOptionMap {
  const options: MissionControlWindowOptionMap = {}
  if (!searchParams) return options
  const globalSearch = normalizeMissionControlSearch(searchParams.get('q') || searchParams.get('search'))
  if (globalSearch) options.all = { search: globalSearch }
  for (const key of Object.keys(MISSION_CONTROL_WINDOW_SPECS) as MissionControlWindowKey[]) {
    const limit = searchParams.get(`${key}Limit`) || searchParams.get(`${key}.limit`)
    const offset = searchParams.get(`${key}Offset`) || searchParams.get(`${key}.offset`)
    const search = searchParams.get(`${key}Search`) || searchParams.get(`${key}.search`)
    if (limit || offset || search) {
      options[key] = {
        ...(limit ? { limit: Number(limit) } : {}),
        ...(offset ? { offset: Number(offset) } : {}),
        ...(search ? { search } : {}),
      }
    }
  }
  return options
}

export function contractsByKey(contracts: MissionControlSourceContract[]): Record<string, MissionControlSourceContract> {
  return Object.fromEntries(contracts.map(contract => [contract.key, contract]))
}

export function isExplicitlyUnavailable(contract: MissionControlSourceContract, sourceFlags: Record<string, unknown>): boolean {
  const keys = WINDOW_AVAILABILITY_KEYS[contract.key as MissionControlWindowKey] || [contract.key as keyof MissionControlSourceAvailability]
  return keys.some(key => sourceFlags[key] === false || (isSourceStateInput(sourceFlags[key]) && sourceFlags[key].available === false))
}

export function selectEvidenceWindowRows<T>(rows: T[], evidenceRows: any[]): T[] {
  const evidenceIds = new Set(evidenceRows.map(row => String(row?.id || '')).filter(Boolean))
  const evidenceRefs = new Set(evidenceRows)
  return rows
    .filter((row: any) => evidenceRefs.has(row) || evidenceIds.has(String(row?.id || '')))
    .slice(0, MISSION_CONTROL_WINDOW_SPECS.evidence.defaultLimit)
}

export function buildMissionControlDashboardSummary(input: MissionControlDashboardSummaryInput): MissionControlDashboardSummary {
  const { health, taskData, sessions, questions, permissions, attention, environments, operationsCockpit } = input
  const contractValidation = validateMissionControlDashboardContract(input)
  const counts = taskData?.counts || {}
  const activeRunSessionIds = new Set(
    asArray<MissionControlRunRowContract>(taskData?.runs)
      .filter(run => run.status === 'running' && run.sessionId)
      .map(run => run.sessionId),
  )
  const sessionRows = asArray<MissionControlSessionRowContract>(sessions?.sessions)
  const knownSessionIds = new Set(sessionRows.map(session => session.id).filter(Boolean))
  const sessionRunning = Math.max(sessions?.counts?.running || 0, activeRunSessionIds.size)
  const sessionTotal = (sessions?.counts?.total || sessionRows.length || 0)
    + [...activeRunSessionIds].filter(id => !knownSessionIds.has(id)).length
  const scheduler = health?.scheduler
  const schedulerComponent = Array.isArray(health?.components) ? health.components.find(row => row?.id === 'scheduler') : undefined
  const activeIssues = asArray<MissionControlTaskRowContract>(taskData?.tasks)
    .filter(task => isActiveTaskStatus(task.status))
    .map(task => ({
      id: String(task.id || ''),
      status: String(task.status || ''),
      priority: String(task.priority || ''),
      title: String(task.title || task.description || ''),
      agent: String(task.agent || ''),
      currentStage: String(task.currentStage || 'complete'),
    }))
  const initiatives = asArray<MissionControlRoadmapRowContract>(taskData?.roadmaps)
    .filter(roadmap => roadmap.status !== 'archived')
    .map(roadmap => ({
      id: String(roadmap.id || ''),
      status: String(roadmap.status || ''),
      priority: String(roadmap.priority || ''),
      title: String(roadmap.title || ''),
    }))
  const sourceStateView = input.sourceContracts
    ? buildMissionControlSourceStateViewModel({ sourceContracts: input.sourceContracts })
    : undefined

  return {
    status: String(health?.status || 'unknown'),
    scheduler: scheduler
      ? `${scheduler.enabled ? 'enabled' : 'paused'} | ${scheduler.maxConcurrent || 0} max | ${asArray<string>(scheduler.defaultPipeline).join(' -> ')}`
      : `${schedulerComponent?.status || 'unknown'} | ${schedulerComponent?.summary || 'scheduler health unavailable'}`,
    taskCounts: formatTaskCounts(counts, { includeArchived: true }),
    gatewaySessions: `${sessionRunning} running / ${sessionTotal} total`,
    environments: environments?.environments ? formatMissionControlEnvironmentCounts(environments.environments) : undefined,
    requests: `${asArray(questions?.questions).length} questions | ${asArray(permissions?.permissions).length} permissions`,
    attention: contractValidation.status === 'fail'
      ? `Mission Control input contract failed: ${contractValidation.failures.map(row => row.field).join(', ')}`
      : attention?.attention?.summary,
    operationsCockpit: operationsCockpit
      ? {
          status: operationsCockpit.status,
          summary: operationsCockpit.summary,
          items: operationsCockpit.items.map(item => ({ id: item.id, status: item.status, nextAction: item.nextAction })),
        }
      : undefined,
    sources: sourceStateView?.sourceSummary,
    sourceStateView,
    activeIssues,
    initiatives,
  }
}

export function validateMissionControlDashboardContract(input: MissionControlDashboardSummaryInput): MissionControlDashboardContractValidation {
  const failures: MissionControlDashboardContractValidation['failures'] = []
  const requiredFields = [
    'health.status',
    'taskData.counts',
    'taskData.tasks',
    'taskData.roadmaps',
    'taskData.runs',
    'sessions.sessions',
    'sessions.counts',
    'questions.questions',
    'permissions.permissions',
  ]
  const fail = (field: string, summary: string) => failures.push({ field, summary })
  const isRecord = (value: unknown) => Boolean(value && typeof value === 'object' && !Array.isArray(value))

  if (!input.health || typeof input.health.status !== 'string') fail('health.status', 'Dashboard health status must be a string.')
  if (!input.taskData || !isRecord(input.taskData.counts)) fail('taskData.counts', 'Task data counts must be an object.')
  if (!Array.isArray(input.taskData?.tasks)) fail('taskData.tasks', 'Task rows must be an array, even when empty.')
  if (!Array.isArray(input.taskData?.roadmaps)) fail('taskData.roadmaps', 'Roadmap rows must be an array, even when empty.')
  if (!Array.isArray(input.taskData?.runs)) fail('taskData.runs', 'Run rows must be an array, even when empty.')
  if (!Array.isArray(input.sessions?.sessions)) fail('sessions.sessions', 'Session rows must be an array, even when empty.')
  if (!input.sessions || !isRecord(input.sessions.counts)) fail('sessions.counts', 'Session counts must be an object.')
  if (!Array.isArray(input.questions?.questions)) fail('questions.questions', 'Question rows must be an array, even when empty.')
  if (!Array.isArray(input.permissions?.permissions)) fail('permissions.permissions', 'Permission rows must be an array, even when empty.')

  return {
    schemaVersion: 1,
    mode: 'mission_control_dashboard_input_contract',
    status: failures.length ? 'fail' : 'pass',
    requiredFields,
    deterministicOrdering: 'preserve_source_order_filter_in_view_model',
    redaction: 'support_safe_ids_only',
    failures,
  }
}

export function buildMissionControlSourceSummary(contracts: MissionControlSourceContract[]): MissionControlSourceSummary {
  const counts = emptySourceStateCounts()
  const items = contracts.map(contract => ({
    key: contract.key,
    label: contract.label,
    route: contract.route,
    state: contract.state,
    severity: contract.severity,
    available: contract.available,
    diagnostic: contract.diagnostic === undefined ? undefined : safeCockpitText(contract.diagnostic),
    nextAction: safeCockpitText(contract.nextAction),
  }))
  for (const item of items) counts[item.state] += 1
  const status = aggregateSourceStatus(items.map(item => item.state))
  const severity = sourceSeverity(status)
  const nonReady = items.filter(item => item.state !== 'ready' && item.state !== 'empty')
  const summary = nonReady.length
    ? `${nonReady.length} Mission Control source(s) need source-state attention; ${counts.partial} partial, ${counts.stale} stale, ${counts.degraded + counts.missing} degraded or missing, ${counts.blocked + counts.error} blocked or error.`
    : 'Mission Control sources are fresh or empty with no source-state blockers.'
  return { status, severity, summary, counts, items }
}

export function buildMissionControlSourceStateViewModel(input: MissionControlSourceStateViewModelInput): MissionControlSourceStateViewModel {
  const highVolumeThreshold = clampInteger(input.highVolumeThreshold, 250, 1, 10000)
  const contracts = [...input.sourceContracts]
  const sourceSummary = buildMissionControlSourceSummary(contracts)
  const sources = contracts.map(contract => buildSourceStateViewSource(contract, highVolumeThreshold, input.evidenceLinks))
  const counts = {
    sources: sources.length,
    totalRows: sources.reduce((sum, source) => sum + source.totals.total, 0),
    matchedRows: sources.reduce((sum, source) => sum + source.totals.matched, 0),
    shownRows: sources.reduce((sum, source) => sum + source.totals.shown, 0),
    truncatedSources: sources.filter(source => source.totals.truncated).length,
    highVolumeSources: sources.filter(source => source.totals.highVolume).length,
    unavailableSources: sources.filter(source => !source.available).length,
    staleSources: sources.filter(source => source.state === 'stale').length,
    blockedOrErrorSources: sources.filter(source => source.state === 'blocked' || source.state === 'error').length,
  }
  const actionAvailability = emptySourceActionCounts()
  for (const source of sources) actionAvailability[source.operatorAction.kind] += 1
  const evidenceLinks = uniqueStrings(sources.flatMap(source => source.evidenceLinks))
  const attention = sources
    .filter(source => !['ready', 'empty'].includes(source.state))
    .map(source => `${source.label}: ${source.nextAction}`)
  const issues: MissionControlSourceStateViewModel['issues'] = []
  const boundedWindows = sources.every(source => source.totals.limit > 0 && source.totals.shown <= source.totals.limit)
  const actionAvailabilityTotal = Object.values(actionAvailability).reduce((sum, count) => sum + count, 0)
  const actionAvailabilityRecorded = sources.length > 0
    && actionAvailabilityTotal === sources.length
    && sources.every(source => actionAvailability[source.operatorAction.kind] > 0 && Boolean(source.operatorAction.label.trim()))
  const evidenceLinksSupportSafe = evidenceLinks.every(link => /^source:[a-zA-Z0-9_-]+$/.test(link) || /^route:[#/\w.-]+$/.test(link) || /^doc:[\w./-]+$/.test(link))
  const hasDegradedSources = sources.some(source => ['degraded', 'missing', 'blocked', 'error', 'stale'].includes(source.state))
  const degradedSourcesVisible = hasDegradedSources
    ? sources
        .filter(source => ['degraded', 'missing', 'blocked', 'error', 'stale'].includes(source.state))
        .every(source => Boolean(source.nextAction))
    : true
  const acceptance = {
    deterministicOrdering: sources.map(source => source.key).join('|') === contracts.map(contract => contract.key).join('|'),
    boundedWindows,
    degradedSourcesVisible,
    actionAvailabilityRecorded,
    evidenceLinksSupportSafe,
    noReleaseClaimExpansion: true as const,
  }
  for (const [name, ok] of Object.entries(acceptance)) {
    if (!ok) issues.push({ code: `acceptance_failed:${name}`, severity: 'critical', summary: `Mission Control source-state view-model acceptance failed: ${name}.` })
  }
  return {
    schemaVersion: 1,
    mode: 'mission_control_source_state_view_model',
    generatedAt: input.generatedAt || new Date().toISOString(),
    status: sourceSummary.status,
    severity: sourceSummary.severity,
    releaseClaimBoundary: 'local_beta_read_model_only_no_hosted_arbitrary_scale_or_unattended_claim',
    sourceSummary,
    counts,
    window: {
      bounded: boundedWindows,
      deterministicOrdering: 'preserve_contract_order',
      sourceKeys: sources.map(source => source.key),
      highVolumeThreshold,
      largestConfiguredLimit: sources.reduce((max, source) => Math.max(max, source.totals.limit), 0),
    },
    actionAvailability,
    redaction: 'support_safe_ids_routes_actions_only',
    sources,
    evidenceLinks,
    attention,
    acceptance,
    unsupportedClaims: [
      'hosted mission control readiness',
      'arbitrary-scale dashboard readiness',
      'raw transcript or provider-payload diagnostics',
      'unattended production operation',
    ],
    issues,
  }
}

export function buildMissionControlDataPlaneV2(input: MissionControlDataPlaneInput): MissionControlDataPlaneV2 {
  const sourceContracts = [...input.sourceContracts]
  const sourceSummary = buildMissionControlSourceSummary(sourceContracts)
  const requestedConsumers: MissionControlDataPlaneConsumer[] = input.consumers?.length ? input.consumers : ['dashboard', 'mcp', 'support']
  const consumers: MissionControlDataPlaneConsumerContract[] = requestedConsumers.map(consumer => ({
    consumer,
    truthVocabulary: 'mission_control_source_contracts' as const,
    readOnly: true as const,
    redaction: 'support_safe' as const,
    summary: `${consumer} consumes the same bounded Mission Control source contracts and support-safe source-state vocabulary.`,
  }))
  const windowTotals = {
    sources: sourceContracts.length,
    totalRows: sumSourceContracts(sourceContracts, 'total'),
    matchedRows: sumSourceContracts(sourceContracts, 'matched'),
    shownRows: sumSourceContracts(sourceContracts, 'shown'),
    truncatedSources: sourceContracts.filter(contract => contract.truncated).length,
    unavailableSources: sourceContracts.filter(contract => !contract.available).length,
    staleSources: sourceContracts.filter(contract => contract.state === 'stale').length,
    blockedOrErrorSources: sourceContracts.filter(contract => contract.state === 'blocked' || contract.state === 'error').length,
    largestConfiguredLimit: sourceContracts.reduce((max, contract) => Math.max(max, contract.limit), 0),
  }
  const acceptance = {
    boundedWindows: sourceContracts.length > 0 && sourceContracts.every(contract => contract.shown <= contract.limit && contract.limit > 0),
    readOnlyProjection: true as const,
    sharedTruthVocabulary: consumers.length > 0 && consumers.every(consumer => consumer.truthVocabulary === 'mission_control_source_contracts'),
    supportSafeSummary: true as const,
    noReleaseClaimExpansion: true as const,
  }
  const errors = Object.entries(acceptance)
    .filter(([, ok]) => !ok)
    .map(([name]) => `acceptance_failed:${name}`)
  const sourceDegradedCount = sourceSummary.counts.degraded + sourceSummary.counts.missing + sourceSummary.counts.error + sourceSummary.counts.blocked
  const status: MissionControlDataPlaneStatus = errors.length || windowTotals.blockedOrErrorSources > 0
    ? 'blocked'
    : windowTotals.unavailableSources > 0 || windowTotals.staleSources > 0 || sourceDegradedCount > 0
      ? 'degraded'
      : windowTotals.truncatedSources > 0 || sourceSummary.status === 'partial'
        ? 'bounded'
        : 'ready'
  return {
    schemaVersion: 1,
    mode: 'm41_mission_control_data_plane_v2',
    generatedAt: input.generatedAt || new Date().toISOString(),
    status,
    releaseClaimBoundary: 'local_beta_high_volume_read_model_only_no_hosted_or_unattended_claim',
    summary: dataPlaneSummary(status, windowTotals),
    sourceSummary,
    consumers,
    windowTotals,
    acceptance,
    errors,
    unsupportedClaims: [
      'hosted mission control readiness',
      'unattended production dashboard operation',
      'arbitrary-scale dashboard readiness',
      'raw transcript or provider-payload support diagnostics',
    ],
  }
}

export function formatMissionControlDataPlaneText(report: MissionControlDataPlaneV2): string[] {
  return [
    `Data Plane: ${report.status} — ${report.summary}`,
    `Rows: ${report.windowTotals.shownRows}/${report.windowTotals.matchedRows} shown across ${report.windowTotals.sources} sources; ${report.windowTotals.truncatedSources} bounded window(s).`,
    `Sources: ${report.sourceSummary.summary}`,
    `Consumers: ${report.consumers.map(consumer => consumer.consumer).join(', ')} share ${report.consumers[0]?.truthVocabulary || 'unknown'} (${report.consumers.every(consumer => consumer.readOnly) ? 'read-only' : 'review'}).`,
    `Claim boundary: ${report.releaseClaimBoundary}.`,
  ]
}

export function buildOperationsCockpit(input: OperationsCockpitInput = {}): OperationsCockpitSummary {
  const checks = asArray<any>(input.readiness?.checks)
  const check = (name: string) => checks.find(row => row?.name === name)
  const sourceFailures = asArray(input.sourceDiagnostics).filter(row => row && row.available !== true)
  const generatedAt = String(
    input.generatedAt ||
      input.operator?.generatedAt ||
      new Date().toISOString(),
  )
  const releaseUnsupported = [
    'hosted SaaS readiness',
    'multi-tenant production readiness',
    'compliance-certified operation',
    'unattended production operation',
  ]
  const items: OperationsCockpitItem[] = [
    buildBackendActivationItem(check('storage')),
    buildSecretsItem(check('security_secret_lifecycle')),
    buildAuditEvidenceItem(check('compliance_audit_retention')),
    buildReleaseClaimItem(input.operator),
    buildSourceHealthItem(sourceFailures),
  ]
  const counts = emptyOperationsCockpitCounts()
  for (const item of items) counts[item.status] += 1
  const status = overallCockpitStatus(items)
  const blocked = counts.blocked + counts.unavailable
  const attention = counts.attention + counts.stale
  const preview = counts.preview + counts.deferred + counts.unsupported
  const summary = blocked
    ? `${blocked} operation area(s) are blocked or unavailable; ${attention} need attention and ${preview} remain preview/deferred/unsupported.`
    : attention
      ? `${attention} operation area(s) need attention; ${preview} remain preview/deferred/unsupported.`
      : preview
        ? `${preview} operation area(s) remain preview/deferred/unsupported; local release-candidate surfaces are visible.`
        : 'Local release-candidate operation surfaces are ready with bounded claims.'
  return {
    mode: 'operations_cockpit',
    generatedAt,
    status,
    summary,
    items,
    counts,
    unsupportedClaims: uniqueStrings([
      ...releaseUnsupported,
      ...items.flatMap(item => item.unsupportedClaims),
    ]),
    releaseClaimBoundary: 'Visibility only: local release-candidate and bounded team-preview state. Hosted, SaaS, multi-tenant, compliance-certified, marketplace-safe, and unattended production claims require an explicit release-claim decision.',
  }
}

function sumSourceContracts(contracts: MissionControlSourceContract[], field: 'total' | 'matched' | 'shown'): number {
  return contracts.reduce((sum, contract) => sum + contract[field], 0)
}

function buildSourceStateViewSource(
  contract: MissionControlSourceContract,
  highVolumeThreshold: number,
  evidenceLinks: MissionControlSourceStateViewModelInput['evidenceLinks'],
): MissionControlSourceStateViewModelSource {
  const highVolume = contract.truncated || contract.hasMore || contract.total >= highVolumeThreshold || contract.matched >= highVolumeThreshold
  return {
    key: contract.key,
    label: contract.label,
    view: contract.view,
    route: contract.route,
    state: contract.state,
    severity: contract.severity,
    available: contract.available,
    searchable: contract.searchable,
    totals: {
      total: contract.total,
      matched: contract.matched,
      shown: contract.shown,
      limit: contract.limit,
      offset: contract.offset,
      hasMore: contract.hasMore,
      truncated: contract.truncated,
      highVolume,
    },
    search: contract.search,
    diagnostic: contract.diagnostic ? safeCockpitText(contract.diagnostic) : undefined,
    nextAction: safeCockpitText(contract.nextAction),
    operatorAction: sourceOperatorAction(contract),
    freshness: {
      checkedAt: contract.checkedAt,
      freshnessMs: contract.freshnessMs,
      ageMs: contract.ageMs,
      state: contract.state === 'stale'
        ? 'stale'
        : contract.checkedAt && contract.ageMs !== undefined
          ? 'fresh'
          : 'unknown',
    },
    evidenceLinks: sourceEvidenceLinks(contract, evidenceLinks),
  }
}

function sourceOperatorAction(contract: MissionControlSourceContract): MissionControlSourceOperatorAction {
  if (contract.state === 'partial') {
    return {
      kind: 'paginate',
      available: true,
      label: `Inspect more ${contract.label}`,
      route: contract.route,
      reason: `Only ${contract.shown}/${contract.matched} matched row(s) are visible in the current bounded window.`,
    }
  }
  if (contract.state === 'stale') {
    return {
      kind: 'refresh',
      available: true,
      label: `Refresh ${contract.label}`,
      route: contract.route,
      reason: contract.ageMs !== undefined && contract.freshnessMs !== undefined
        ? `Source age ${contract.ageMs}ms exceeded freshness window ${contract.freshnessMs}ms.`
        : 'Source freshness check is stale.',
    }
  }
  if (contract.state === 'degraded' || contract.state === 'missing' || contract.state === 'blocked' || contract.state === 'error') {
    return {
      kind: 'repair',
      available: true,
      label: `Repair ${contract.label}`,
      route: contract.route,
      reason: safeCockpitText(contract.diagnostic || contract.nextAction || `${contract.label} source is not trustworthy yet.`),
    }
  }
  if (contract.state === 'loading') {
    return {
      kind: 'wait',
      available: false,
      label: `Wait for ${contract.label}`,
      route: contract.route,
      reason: `${contract.label} is still loading.`,
    }
  }
  if (contract.state === 'empty') {
    return {
      kind: 'none',
      available: false,
      label: `No ${contract.label} action`,
      route: contract.route,
      reason: `${contract.label} has no current rows.`,
    }
  }
  return {
    kind: 'inspect',
    available: true,
    label: `Inspect ${contract.label}`,
    route: contract.route,
    reason: `${contract.label} is available from ${contract.route}.`,
  }
}

function sourceEvidenceLinks(
  contract: MissionControlSourceContract,
  evidenceLinks: MissionControlSourceStateViewModelInput['evidenceLinks'],
): string[] {
  const explicit = [
    ...(evidenceLinks?.['all'] || []),
    ...(evidenceLinks?.[contract.key] || []),
  ]
  return uniqueStrings([
    `source:${safeEvidenceToken(contract.key)}`,
    `route:${safeEvidenceToken(contract.route)}`,
    ...explicit,
  ])
}

function safeEvidenceToken(value: unknown): string {
  return String(value || 'unknown')
    .replace(/[^#/A-Za-z0-9_.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .substring(0, 160) || 'unknown'
}

function emptySourceActionCounts(): Record<MissionControlSourceOperatorActionKind, number> {
  return {
    inspect: 0,
    paginate: 0,
    refresh: 0,
    repair: 0,
    wait: 0,
    none: 0,
  }
}

function dataPlaneSummary(status: MissionControlDataPlaneStatus, totals: MissionControlDataPlaneV2['windowTotals']): string {
  const base = `${totals.shownRows}/${totals.matchedRows} matched row(s) projected from ${totals.sources} bounded source contract(s)`
  if (status === 'blocked') return `${base}; ${totals.blockedOrErrorSources} source(s) are blocked or error.`
  if (status === 'degraded') return `${base}; ${totals.unavailableSources} source(s) are unavailable or degraded.`
  if (status === 'bounded') return `${base}; ${totals.truncatedSources} high-volume window(s) are intentionally bounded.`
  return `${base}; all source windows are ready or empty.`
}

export function formatMissionControlEnvironmentCounts(environments: any[]): string {
  const rows = asArray<any>(environments)
  const active = rows.filter(environment => environment.status === 'prepared' || environment.status === 'blocked').length
  const retained = rows.filter(environment => environment.status === 'retained').length
  const cleanupFailed = rows.filter(environment => environment.status === 'cleanup_failed' || environment.cleanup?.state === 'failed').length
  return `${active} active | ${retained} retained | ${cleanupFailed} cleanup failed`
}

export function normalizeMissionControlSearch(value: unknown): string | undefined {
  const text = String(value || '').trim()
  return text ? text.substring(0, 120) : undefined
}

export function missionControlSearchText(value: unknown): string {
  try {
    return JSON.stringify(value || {}).toLowerCase()
  } catch {
    return String(value || '').toLowerCase()
  }
}

function sourceState(input: { available: boolean; explicit?: MissionControlSourceState; rawRows: number; matched: number; truncated: boolean; checkedAt?: string; freshnessMs?: number; nowMs?: number }): MissionControlSourceState {
  if (input.explicit) return input.explicit
  if (!input.available) return 'degraded'
  const ageMs = sourceAgeMs(input.checkedAt, input.nowMs)
  if (input.freshnessMs !== undefined && ageMs !== undefined && ageMs > input.freshnessMs) return 'stale'
  if (input.truncated) return 'partial'
  if (!input.rawRows || !input.matched) return 'empty'
  return 'ready'
}

function normalizeSourceAvailability(input: boolean | MissionControlSourceStateInput): Required<Pick<MissionControlSourceStateInput, 'available'>> & Omit<MissionControlSourceStateInput, 'available'> {
  if (typeof input === 'boolean') return { available: input }
  return { ...input, available: input.available !== false }
}

function isSourceStateInput(value: unknown): value is MissionControlSourceStateInput {
  return Boolean(value && typeof value === 'object')
}

function sourceAgeMs(checkedAt: string | undefined, nowMs: number | undefined): number | undefined {
  if (!checkedAt || nowMs === undefined) return undefined
  const checkedMs = Date.parse(checkedAt)
  if (!Number.isFinite(checkedMs)) return undefined
  return Math.max(0, nowMs - checkedMs)
}

function sourceSeverity(state: MissionControlSourceState): MissionControlSourceSeverity {
  if (state === 'error' || state === 'blocked') return 'critical'
  if (state === 'partial' || state === 'stale' || state === 'degraded' || state === 'missing') return 'warning'
  if (state === 'loading' || state === 'empty') return 'info'
  return 'ok'
}

function sourceNextAction(input: { label: string; route: string; view: string; state: MissionControlSourceState; nextAction?: string }): string {
  if (input.nextAction) return safeCockpitText(input.nextAction)
  if (input.state === 'error') return `Fix ${input.label} source errors before trusting ${input.view}.`
  if (input.state === 'blocked') return `Resolve the blocker for ${input.label} before trusting ${input.view}.`
  if (input.state === 'missing' || input.state === 'degraded') return `Restore ${input.label} from ${input.route}; Gateway-owned data remains visible.`
  if (input.state === 'stale') return `Refresh ${input.label}; the last source check exceeded its freshness window.`
  if (input.state === 'partial') return `Use pagination or source-specific search to inspect the remaining ${input.label} rows.`
  if (input.state === 'loading') return `Wait for ${input.label} to finish loading before treating it as complete.`
  if (input.state === 'empty') return `No ${input.label} rows are currently present.`
  return 'No source action required.'
}

function aggregateSourceStatus(states: MissionControlSourceState[]): MissionControlSourceState {
  const set = new Set(states)
  if (set.has('error')) return 'error'
  if (set.has('blocked')) return 'blocked'
  if (set.has('degraded') || set.has('missing')) return 'degraded'
  if (set.has('stale')) return 'stale'
  if (set.has('partial')) return 'partial'
  if (set.has('loading')) return 'loading'
  if (set.has('ready')) return 'ready'
  return 'empty'
}

function emptySourceStateCounts(): Record<MissionControlSourceState, number> {
  return {
    loading: 0,
    ready: 0,
    empty: 0,
    partial: 0,
    stale: 0,
    degraded: 0,
    missing: 0,
    blocked: 0,
    error: 0,
  }
}

function buildBackendActivationItem(readinessCheck: any): OperationsCockpitItem {
  const backend = readinessCheck?.details?.backend
  const activation = backend?.activation
  const consistency = readinessCheck?.details?.consistency
  const activationStatus = String(activation?.status || '')
  const status: OperationsCockpitStatus = consistency?.status === 'fail' || activationStatus === 'preview_blocked'
    ? 'blocked'
    : consistency?.status === 'warn'
      ? 'attention'
    : activationStatus.startsWith('preview_')
      ? 'preview'
      : readinessCheckStatus(readinessCheck, 'ready')
  return cockpitItem({
    id: 'backend_activation',
    label: 'Backend',
    status,
    summary: activation
      ? `${activationStatus || 'unknown'} / runtime ${backend?.mode || 'unknown'} / consistency ${consistency?.status || 'unknown'} / backup ${consistency?.backup?.status || 'unknown'} / rollback ${consistency?.rollback?.status || activation.rollbackReadiness || 'unknown'}`
      : readinessCheck?.summary || 'Backend activation posture is unavailable.',
    nextAction: consistency?.status === 'fail'
      ? firstBlockerSummary(consistency?.blockedStates) || 'Run backend consistency proof and resolve critical storage blockers.'
      : activationStatus === 'preview_blocked'
      ? firstBlockerSummary(activation?.blockers) || 'Run backend preflight and resolve blocked preview configuration.'
      : consistency?.status === 'warn'
        ? firstBlockerSummary(consistency?.blockedStates) || 'Create a verified backup or resolve degraded backend consistency warnings.'
      : activationStatus.startsWith('preview_')
        ? 'Run backend preflight and rollback drills before any backend preview claim.'
        : 'Keep local SQLite as the supported runtime until closeout expands the claim.',
    command: firstSupportedCommand(activation?.supportedCommands, 'consistency_proof') || 'opencode-gateway backend consistency-proof --json',
    source: 'readiness.storage.backend.activation',
    route: '#/health',
    claim: consistency?.releaseClaim || (activationStatus.startsWith('preview_') ? 'backend_preview_only' : 'supported_local_sqlite'),
    previewOnly: activationStatus.startsWith('preview_'),
    blockers: uniqueStrings([...blockerCodes(activation?.blockers), ...blockerCodes(consistency?.blockedStates)]),
    unsupportedClaims: uniqueStrings(['hosted backend readiness', 'multi-tenant storage readiness', ...asArray<string>(consistency?.unsupportedClaims)]),
  })
}

function buildSecretsItem(readinessCheck: any): OperationsCockpitItem {
  return cockpitItem({
    id: 'secrets',
    label: 'Secrets',
    status: readinessCheckStatus(readinessCheck, 'ready'),
    summary: readinessCheck?.summary || 'Secret lifecycle report is unavailable.',
    nextAction: readinessCheck?.status === 'pass'
      ? 'Keep using value-free secret references and scoped injection evidence.'
      : firstBlockerSummary(readinessCheck?.details?.risks) || 'Resolve secret lifecycle risks and rerun readiness.',
    source: 'readiness.security_secret_lifecycle',
    route: '#/health',
    claim: readinessCheck?.details?.releaseStatus || 'local_operator_managed_secrets',
    blockers: blockerCodes(readinessCheck?.details?.risks),
    unsupportedClaims: ['hosted/team vaulting without explicit closeout evidence'],
  })
}

function buildAuditEvidenceItem(readinessCheck: any): OperationsCockpitItem {
  return cockpitItem({
    id: 'audit_evidence',
    label: 'Audit evidence',
    status: readinessCheckStatus(readinessCheck, 'ready'),
    summary: readinessCheck?.summary || 'Audit and evidence retention report is unavailable.',
    nextAction: readinessCheck?.status === 'pass'
      ? 'Export the redacted release evidence pack before a release decision.'
      : 'Resolve audit/evidence retention blockers before release review.',
    command: 'opencode-gateway evidence export --redacted',
    source: 'readiness.compliance_audit_retention',
    route: '#/release-cockpit',
    claim: readinessCheck?.details?.releaseStatus || 'local_redacted_evidence',
    blockers: blockerCodes(readinessCheck?.details?.risks),
    unsupportedClaims: ['compliance-certified audit storage', 'raw transcript retention'],
  })
}

function buildReleaseClaimItem(operator: any): OperationsCockpitItem {
  const productionCertified = operator?.releaseClaim?.productionCertified === true
  return cockpitItem({
    id: 'release_claim',
    label: 'Release claim',
    status: productionCertified ? 'ready' : 'unsupported',
    summary: operator?.releaseClaim?.scope || 'Release claim boundary is unavailable.',
    nextAction: productionCertified
      ? 'Review and approve the release-claim record before changing release language.'
      : 'Keep release copy bounded to local beta/RC visibility until an explicit release-claim decision approves any expansion.',
    source: 'operator.releaseClaim',
    route: '#/operator',
    claim: productionCertified ? 'closeout_review_required' : 'no_claim_change',
    blockers: asArray<string>(operator?.releaseClaim?.notes).slice(0, 5),
    unsupportedClaims: ['hosted readiness', 'team-production readiness', 'multi-tenant readiness'],
  })
}

function buildSourceHealthItem(sourceFailures: Array<{ source?: string; available?: boolean; summary?: string }>): OperationsCockpitItem {
  return cockpitItem({
    id: 'mission_control_sources',
    label: 'Data sources',
    status: sourceFailures.length ? 'stale' : 'ready',
    summary: sourceFailures.length
      ? `${sourceFailures.length} Mission Control source(s) are unavailable or degraded.`
      : 'Mission Control sources loaded or no source degradation was reported.',
    nextAction: sourceFailures.length
      ? `Review source diagnostics for ${sourceFailures.slice(0, 3).map(row => row.source || 'unknown').join(', ')}.`
      : 'No source recovery action is currently required.',
    source: 'mission_control.sourceDiagnostics',
    route: '#/work-graph',
    claim: sourceFailures.length ? 'partial_source_visibility' : 'source_visibility_available',
    blockers: sourceFailures.map(row => `${row.source || 'unknown'}:${row.summary || 'unavailable'}`).slice(0, 6),
    unsupportedClaims: ['green readiness with stale or unavailable sources'],
  })
}

function cockpitItem(input: Omit<OperationsCockpitItem, 'summary' | 'nextAction' | 'source' | 'blockers' | 'unsupportedClaims'> & {
  summary?: unknown
  nextAction?: unknown
  source?: unknown
  blockers?: unknown[]
  unsupportedClaims?: unknown[]
}): OperationsCockpitItem {
  return {
    ...input,
    summary: safeCockpitText(input.summary || 'No summary available.'),
    nextAction: safeCockpitText(input.nextAction || 'Review the linked source before proceeding.'),
    source: safeCockpitText(input.source || 'mission_control'),
    blockers: asArray(input.blockers).map(safeCockpitText).filter(Boolean).slice(0, 8),
    unsupportedClaims: asArray(input.unsupportedClaims).map(safeCockpitText).filter(Boolean).slice(0, 8),
  }
}

function readinessCheckStatus(check: any, passStatus: OperationsCockpitStatus): OperationsCockpitStatus {
  if (!check) return 'unavailable'
  if (check.status === 'pass') return passStatus
  if (check.status === 'fail' || check.severity === 'critical') return 'blocked'
  return 'attention'
}

function firstSupportedCommand(commands: unknown, preferredId?: string): string | undefined {
  const rows = asArray<any>(commands)
  const preferred = preferredId ? rows.find(row => row?.id === preferredId) : undefined
  const row = preferred || rows[0]
  return row?.command ? safeCockpitText(row.command) : undefined
}

function firstBlockerSummary(blockers: unknown): string | undefined {
  const row = asArray<any>(blockers)[0]
  if (!row) return undefined
  return safeCockpitText(row.summary || row.remediation || row.code || row.reason)
}

function blockerCodes(blockers: unknown): string[] {
  return asArray<any>(blockers)
    .map(row => row?.code || row?.id || row?.summary || row?.reason || row)
    .map(safeCockpitText)
    .filter(Boolean)
    .slice(0, 8)
}

function overallCockpitStatus(items: OperationsCockpitItem[]): OperationsCockpitStatus {
  const statuses = new Set(items.map(item => item.status))
  if (statuses.has('blocked') || statuses.has('unavailable')) return 'blocked'
  if (statuses.has('attention') || statuses.has('stale')) return 'attention'
  if (statuses.has('preview') || statuses.has('deferred') || statuses.has('unsupported')) return 'preview'
  return 'ready'
}

function emptyOperationsCockpitCounts(): Record<OperationsCockpitStatus, number> {
  return {
    ready: 0,
    attention: 0,
    blocked: 0,
    preview: 0,
    deferred: 0,
    stale: 0,
    unavailable: 0,
    unsupported: 0,
  }
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map(safeCockpitText).filter(Boolean))]
}

function safeCockpitText(value: unknown): string {
  return String(value || '')
    .replace(/(token|secret|password|authorization|cookie)=([^;\s]+)/gi, '$1=<redacted>')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/g, 'Bearer <redacted>')
    .substring(0, 500)
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.floor(parsed)))
}

function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : []
}
