import {
  COWORK_FLEET_REGISTRY_SCHEMA_VERSION,
  type AutomationListPayload,
  type AutomationStatus,
  type BuiltInAgentDetail,
  type CapabilitySkill,
  type CapabilityTool,
  type CrewLifecycleStatus,
  type CrewListItem,
  type CrewRunStatus,
  type CustomAgentSummary,
  type FleetBulkAction,
  type FleetBulkActionKind,
  type FleetRegistryItem,
  type FleetRegistryStatus,
  type RuntimeAgentDescriptor,
  type RuntimeToolDescriptor,
} from '@open-cowork/shared'

export const FLEET_REGISTRY_FEATURE_GATE_KEY = 'open-cowork.feature.fleetRegistryViews'
export const FLEET_REGISTRY_LARGE_INVENTORY_THRESHOLD = 24

export type FleetRegistrySurface = 'agents' | 'crews' | 'automations' | 'capabilities'
export type FleetRegistryViewMode = 'cards' | 'table'
export type FleetRegistryQuickFilter =
  | 'all'
  | 'active'
  | 'paused'
  | 'failing'
  | 'unused'
  | 'expensive'
  | 'missing_credentials'
  | 'waiting_review'
  | 'custom_only'
  | 'builtin_runtime'
export type FleetRegistrySortKey =
  | 'name'
  | 'kind'
  | 'status'
  | 'source'
  | 'model'
  | 'capabilities'
  | 'activity'
  | 'runs'
  | 'backlog'
  | 'cost'
  | 'tokens'
export type FleetRegistrySortDirection = 'asc' | 'desc'

export interface FleetRegistrySort {
  key: FleetRegistrySortKey
  direction: FleetRegistrySortDirection
}

export interface FleetRegistryPreference {
  viewMode?: FleetRegistryViewMode
  quickFilter?: FleetRegistryQuickFilter
  sort?: FleetRegistrySort
}

export const DEFAULT_FLEET_REGISTRY_SORT: FleetRegistrySort = {
  key: 'name',
  direction: 'asc',
}

export const FLEET_REGISTRY_QUICK_FILTERS: Array<{ id: FleetRegistryQuickFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'paused', label: 'Paused' },
  { id: 'failing', label: 'Failing' },
  { id: 'unused', label: 'Unused' },
  { id: 'expensive', label: 'Expensive' },
  { id: 'missing_credentials', label: 'Missing credentials' },
  { id: 'waiting_review', label: 'Waiting review' },
  { id: 'custom_only', label: 'Custom only' },
  { id: 'builtin_runtime', label: 'Built-in/runtime' },
]

export const FLEET_REGISTRY_SORT_LABELS: Record<FleetRegistrySortKey, string> = {
  name: 'Name',
  kind: 'Kind',
  status: 'Status',
  source: 'Source',
  model: 'Model',
  capabilities: 'Capabilities',
  activity: 'Last activity',
  runs: 'Runs',
  backlog: 'Review',
  cost: 'Cost',
  tokens: 'Tokens',
}

function storageOrNull(storage?: Storage | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function fleetRegistryPreferenceKey(surface: FleetRegistrySurface) {
  return `open-cowork.fleetRegistry.${surface}.preferences`
}

export function isFleetRegistryViewsEnabled(storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    return target.getItem(FLEET_REGISTRY_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

export function shouldDefaultFleetRegistryToTable(count: number, threshold = FLEET_REGISTRY_LARGE_INVENTORY_THRESHOLD) {
  return count >= threshold
}

export function readFleetRegistryPreference(surface: FleetRegistrySurface, storage?: Storage | null): FleetRegistryPreference {
  const target = storageOrNull(storage)
  if (!target) return {}
  try {
    const raw = target.getItem(fleetRegistryPreferenceKey(surface))
    if (!raw) return {}
    const parsed = JSON.parse(raw) as FleetRegistryPreference
    return normalizeFleetRegistryPreference(parsed)
  } catch {
    return {}
  }
}

export function writeFleetRegistryPreference(surface: FleetRegistrySurface, preference: FleetRegistryPreference, storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return
  try {
    target.setItem(fleetRegistryPreferenceKey(surface), JSON.stringify(normalizeFleetRegistryPreference(preference)))
  } catch {
    // Renderer preferences are best-effort; unavailable storage should not hide the inventory.
  }
}

export function toggleFleetRegistrySort(current: FleetRegistrySort, key: FleetRegistrySortKey): FleetRegistrySort {
  if (current.key !== key) return { key, direction: key === 'activity' || key === 'runs' || key === 'backlog' ? 'desc' : 'asc' }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
}

function normalizeFleetRegistryPreference(preference: FleetRegistryPreference): FleetRegistryPreference {
  const quickFilter = FLEET_REGISTRY_QUICK_FILTERS.some((entry) => entry.id === preference.quickFilter)
    ? preference.quickFilter
    : undefined
  const viewMode = preference.viewMode === 'cards' || preference.viewMode === 'table' ? preference.viewMode : undefined
  const sort = preference.sort && preference.sort.key in FLEET_REGISTRY_SORT_LABELS
    ? { key: preference.sort.key, direction: preference.sort.direction === 'desc' ? 'desc' : 'asc' } satisfies FleetRegistrySort
    : undefined
  return { viewMode, quickFilter, sort }
}

function compact(values: Array<string | number | null | undefined | false>) {
  return values
    .filter((value): value is string | number => value !== null && value !== undefined && value !== false && String(value).trim().length > 0)
    .map((value) => String(value))
}

function searchText(values: Array<string | number | null | undefined | false>) {
  return compact(values).join(' ').toLowerCase()
}

function statusLabel(status: FleetRegistryStatus) {
  return status.replaceAll('_', ' ')
}

function providerFromModel(model?: string | null) {
  if (!model || !model.includes('/')) return null
  return model.split('/')[0] || null
}

function action(
  kind: FleetBulkActionKind,
  label: string,
  supported: boolean,
  disabledReason?: string,
  options: Partial<Pick<FleetBulkAction, 'destructive' | 'requiresConfirmation' | 'selection'>> = {},
): FleetBulkAction {
  return {
    id: kind,
    kind,
    label,
    supported,
    disabledReason: supported ? null : disabledReason || 'This bulk action is not available for the selected registry item.',
    ...options,
  }
}

function registryItem(input: Omit<FleetRegistryItem, 'schemaVersion' | 'statusLabel' | 'metrics' | 'searchText'> & {
  statusLabel?: string
  metrics?: FleetRegistryItem['metrics']
  searchValues: Array<string | number | null | undefined | false>
}): FleetRegistryItem {
  const { metrics, searchValues: additionalSearchValues, statusLabel: explicitStatusLabel, ...rest } = input
  return {
    schemaVersion: COWORK_FLEET_REGISTRY_SCHEMA_VERSION,
    ...rest,
    statusLabel: explicitStatusLabel || statusLabel(input.status),
    metrics: metrics || [],
    searchText: searchText([
      input.name,
      input.description || '',
      input.typeLabel,
      input.status,
      input.source,
      input.owner || '',
      input.provider || '',
      input.model || '',
      ...input.tags,
      ...additionalSearchValues,
    ]),
  }
}

function mapCrewStatus(status: CrewLifecycleStatus): FleetRegistryStatus {
  if (status === 'active') return 'active'
  if (status === 'paused') return 'paused'
  if (status === 'retired') return 'retired'
  if (status === 'review') return 'waiting_review'
  if (status === 'approved') return 'ready'
  return 'draft'
}

function mapCrewRunActive(status: CrewRunStatus | null | undefined) {
  return status === 'queued' || status === 'planning' || status === 'running' || status === 'blocked' || status === 'evaluating' || status === 'delivering'
}

function mapAutomationStatus(status: AutomationStatus): FleetRegistryStatus {
  if (status === 'needs_user') return 'waiting_review'
  if (status === 'enriching') return 'running'
  return status
}

export function buildAgentRegistryItems(input: {
  customAgents: readonly CustomAgentSummary[]
  builtInAgents: readonly BuiltInAgentDetail[]
  runtimeAgents: readonly RuntimeAgentDescriptor[]
}): FleetRegistryItem[] {
  const customItems = input.customAgents.map((agent) => {
    const status: FleetRegistryStatus = !agent.valid ? 'blocked' : agent.enabled ? 'active' : 'disabled'
    const source = agent.scope === 'project' ? 'Custom project' : 'Custom machine'
    return registryItem({
      id: `agent:custom:${agent.name}`,
      kind: 'agent',
      name: agent.name,
      description: agent.description,
      typeLabel: 'Custom agent',
      status,
      source,
      owner: agent.scope,
      provider: providerFromModel(agent.model),
      model: agent.model || agent.variant || null,
      skillsCount: agent.skillNames.length,
      toolsCount: agent.toolIds.length,
      capabilitiesCount: agent.skillNames.length + agent.toolIds.length,
      lastUsedAt: null,
      lastRunAt: null,
      activeRuns: 0,
      failedRuns: agent.issues.length,
      costUsd: null,
      tokenCount: null,
      reviewBacklog: agent.valid ? 0 : agent.issues.length,
      approvalBacklog: 0,
      tags: compact([
        'custom',
        agent.scope,
        agent.enabled ? 'enabled' : 'disabled',
        agent.writeAccess ? 'write access' : 'read only',
        !agent.valid && 'needs repair',
      ]),
      bulkActions: [
        action('tag', 'Tag selected', false, 'Agent tags are not persisted by the current custom agent service.'),
        action('untag', 'Untag selected', false, 'Agent tags are not persisted by the current custom agent service.'),
        action('duplicate', 'Duplicate agent', false, 'Use Export and Import until custom agent duplication has a backing service.'),
      ],
      metadata: {
        agentName: agent.name,
        agentKind: 'custom',
        scope: agent.scope,
        writeAccess: agent.writeAccess,
        valid: agent.valid,
      },
      searchValues: [
        agent.instructions,
        ...agent.skillNames,
        ...agent.toolIds,
        ...agent.issues.map((issue) => issue.message),
      ],
    })
  })

  const builtInItems = input.builtInAgents.map((agent) => {
    const source = agent.source === 'open-cowork' ? 'Built-in Open Cowork' : 'OpenCode built-in'
    return registryItem({
      id: `agent:builtin:${agent.name}`,
      kind: 'agent',
      name: agent.label || agent.name,
      description: agent.description,
      typeLabel: agent.mode === 'primary' ? 'Primary agent' : 'Subagent',
      status: agent.disabled || agent.hidden ? 'disabled' : 'active',
      source,
      owner: agent.source === 'open-cowork' ? 'Open Cowork' : 'OpenCode',
      provider: providerFromModel(agent.model),
      model: agent.model || agent.variant || null,
      skillsCount: agent.skills.length,
      toolsCount: agent.toolAccess.length,
      capabilitiesCount: agent.skills.length + agent.toolAccess.length,
      lastUsedAt: null,
      lastRunAt: null,
      activeRuns: 0,
      failedRuns: 0,
      costUsd: null,
      tokenCount: null,
      reviewBacklog: 0,
      approvalBacklog: 0,
      tags: compact([
        'built-in',
        agent.source,
        agent.mode,
        agent.hidden && 'hidden',
        agent.disabled && 'disabled',
      ]),
      bulkActions: [
        action('tag', 'Tag selected', false, 'Built-in agent metadata is runtime-owned and cannot be bulk tagged.'),
        action('untag', 'Untag selected', false, 'Built-in agent metadata is runtime-owned and cannot be bulk untagged.'),
        action('duplicate', 'Duplicate agent', false, 'Create a custom agent from this built-in in the agent builder.'),
      ],
      metadata: {
        agentName: agent.name,
        agentKind: 'builtin',
        source: agent.source,
        mode: agent.mode,
        hidden: agent.hidden,
      },
      searchValues: [
        agent.name,
        agent.instructions,
        ...agent.skills,
        ...agent.toolAccess,
        ...agent.nativeToolIds,
        ...agent.configuredToolIds,
      ],
    })
  })

  const runtimeItems = input.runtimeAgents.map((agent) => {
    const toolsCount = agent.toolIds?.length || agent.toolCount || 0
    return registryItem({
      id: `agent:runtime:${agent.name}`,
      kind: 'agent',
      name: agent.name,
      description: agent.description || '',
      typeLabel: agent.mode === 'primary' ? 'Primary runtime agent' : agent.mode === 'subagent' ? 'Runtime subagent' : 'Runtime agent',
      status: agent.disabled ? 'disabled' : 'active',
      source: 'Runtime',
      owner: 'OpenCode plugin',
      provider: providerFromModel(agent.model),
      model: agent.model || null,
      skillsCount: 0,
      toolsCount,
      capabilitiesCount: toolsCount,
      lastUsedAt: null,
      lastRunAt: null,
      activeRuns: 0,
      failedRuns: 0,
      costUsd: null,
      tokenCount: null,
      reviewBacklog: 0,
      approvalBacklog: 0,
      tags: compact(['runtime', agent.mode || 'agent', agent.writeAccess ? 'write access' : 'read only', agent.disabled && 'disabled']),
      bulkActions: [
        action('tag', 'Tag selected', false, 'Runtime agent metadata is supplied by OpenCode plugins.'),
        action('untag', 'Untag selected', false, 'Runtime agent metadata is supplied by OpenCode plugins.'),
        action('duplicate', 'Duplicate agent', false, 'Runtime agents must be converted through the agent builder before duplication.'),
      ],
      metadata: {
        agentName: agent.name,
        agentKind: 'runtime',
        mode: agent.mode || null,
        writeAccess: agent.writeAccess || false,
        steps: agent.steps || null,
      },
      searchValues: [agent.name, agent.description || '', ...(agent.toolIds || [])],
    })
  })

  return [...customItems, ...builtInItems, ...runtimeItems]
}

export function buildCrewRegistryItems(crews: readonly CrewListItem[]): FleetRegistryItem[] {
  return crews.map((crew) => {
    const status = mapCrewStatus(crew.definition.status)
    const memberCount = crew.activeVersion?.members.length || 0
    const latestRunStatus = crew.latestRun?.status || null
    const activeRuns = mapCrewRunActive(latestRunStatus) ? 1 : 0
    const failedRuns = latestRunStatus === 'failed' ? 1 : 0
    return registryItem({
      id: crew.definition.id,
      kind: 'crew',
      name: crew.definition.name,
      description: crew.definition.description,
      typeLabel: 'Agent team',
      status,
      statusLabel: crew.definition.status.replaceAll('_', ' '),
      source: 'Custom crew',
      owner: 'Open Cowork',
      provider: null,
      model: null,
      skillsCount: 0,
      toolsCount: 0,
      capabilitiesCount: memberCount,
      lastUsedAt: crew.definition.updatedAt,
      lastRunAt: crew.latestRun?.startedAt || crew.latestRun?.createdAt || null,
      activeRuns,
      failedRuns,
      costUsd: crew.activeVersion?.budgetCapUsd || null,
      tokenCount: null,
      reviewBacklog: crew.definition.status === 'review' ? 1 : 0,
      approvalBacklog: 0,
      tags: compact([
        'custom',
        'crew',
        `v${crew.activeVersion?.version || 0}`,
        crew.latestRun?.status && `latest ${crew.latestRun.status}`,
        crew.activeVersion?.certificationStatus,
      ]),
      bulkActions: [
        action('tag', 'Tag selected', false, 'Crew tags are not persisted by the current crew service.'),
        action('untag', 'Untag selected', false, 'Crew tags are not persisted by the current crew service.'),
        action('duplicate', 'Duplicate crew', false, 'Crew template duplication needs a backing service before bulk use.'),
      ],
      metadata: {
        version: crew.activeVersion?.version || 0,
        workspaceProfileId: crew.activeVersion?.workspaceProfileId || null,
        certificationStatus: crew.activeVersion?.certificationStatus || null,
      },
      searchValues: [
        crew.definition.status,
        crew.latestRun?.title || '',
        crew.latestRun?.status || '',
        ...(crew.activeVersion?.members || []).flatMap((member) => [member.agentName, member.displayName, member.role]),
      ],
    })
  })
}

export function buildAutomationRegistryItems(payload: AutomationListPayload): FleetRegistryItem[] {
  const runsByAutomation = groupBy(payload.runs, (run) => run.automationId)
  const inboxByAutomation = groupBy(payload.inbox.filter((entry) => entry.status === 'open'), (entry) => entry.automationId)
  const workItemsByAutomation = groupBy(payload.workItems, (workItem) => workItem.automationId)
  return payload.automations.map((automation) => {
    const runs = runsByAutomation.get(automation.id) || []
    const inbox = inboxByAutomation.get(automation.id) || []
    const workItems = workItemsByAutomation.get(automation.id) || []
    const activeRuns = runs.filter((run) => run.status === 'queued' || run.status === 'running' || run.status === 'needs_user').length
    const blockingRuns = runs.filter((run) => run.status === 'queued' || run.status === 'running').length
    const failedRuns = runs.filter((run) => run.status === 'failed').length
    const reviewBacklog = inbox.filter((entry) => entry.type === 'approval' || entry.type === 'clarification' || entry.type === 'failure').length
    const approvalBacklog = inbox.filter((entry) => entry.type === 'approval').length
    const status = mapAutomationStatus(automation.status)
    const canPause = automation.status !== 'paused' && automation.status !== 'archived'
    const canResume = automation.status === 'paused' || automation.status === 'archived'
    const canArchive = automation.status !== 'archived' && blockingRuns === 0
    return registryItem({
      id: automation.id,
      kind: 'automation',
      name: automation.title,
      description: automation.goal,
      typeLabel: automation.kind === 'managed-project' ? 'Managed project' : 'Recurring automation',
      status,
      statusLabel: automation.status.replaceAll('_', ' '),
      source: 'Automation',
      owner: automation.projectDirectory || 'Global',
      provider: null,
      model: automation.executionMode.replaceAll('_', ' '),
      skillsCount: 0,
      toolsCount: 0,
      capabilitiesCount: automation.preferredAgentNames.length,
      lastUsedAt: automation.lastHeartbeatAt,
      lastRunAt: automation.lastRunAt,
      activeRuns,
      failedRuns,
      costUsd: null,
      tokenCount: null,
      reviewBacklog,
      approvalBacklog,
      tags: compact([
        automation.kind,
        automation.executionMode.replaceAll('_', ' '),
        automation.autonomyPolicy,
        automation.latestRunStatus && `latest ${automation.latestRunStatus}`,
        automation.nextRunAt && 'scheduled',
      ]),
      bulkActions: [
        action('pause', 'Pause selected', canPause, 'Only non-archived automations can be paused.'),
        action('resume', 'Resume selected', canResume, 'Only paused or archived automations can be resumed.'),
        action('archive', 'Archive selected', canArchive, 'Only non-archived automations without queued or running work can be archived.', { destructive: true, requiresConfirmation: true }),
        action('duplicate', 'Duplicate automation', false, 'Automation template duplication needs a backing service before bulk use.'),
      ],
      metadata: {
        scheduleType: automation.schedule.type,
        heartbeatMinutes: automation.heartbeatMinutes,
        workItems: workItems.length,
        updatedAt: automation.updatedAt,
      },
      searchValues: [
        automation.kind,
        automation.status,
        automation.executionMode,
        automation.autonomyPolicy,
        automation.projectDirectory || '',
        ...automation.preferredAgentNames,
        ...runs.flatMap((run) => [run.title, run.summary || '', run.error || '', run.status]),
        ...inbox.flatMap((entry) => [entry.title, entry.body, entry.type]),
        ...workItems.flatMap((workItem) => [workItem.title, workItem.description, workItem.status, workItem.ownerAgent || '']),
      ],
    })
  })
}

export function buildCapabilityRegistryItems(input: {
  tools: readonly CapabilityTool[]
  skills: readonly CapabilitySkill[]
  runtimeTools?: readonly RuntimeToolDescriptor[]
}): FleetRegistryItem[] {
  const skillByToolId = new Map<string, CapabilitySkill[]>()
  for (const skill of input.skills) {
    for (const toolId of skill.toolIds || []) {
      const list = skillByToolId.get(toolId) || []
      list.push(skill)
      skillByToolId.set(toolId, list)
    }
  }

  const toolItems = input.tools.map((tool) => {
    const linkedSkills = skillByToolId.get(tool.id) || []
    const methodsCount = runtimeMethodCount(tool, input.runtimeTools || [])
    const missingCredentials = tool.authMode === 'api_token' && tool.enabled === false
    return registryItem({
      id: `capability:tool:${tool.id}`,
      kind: 'capability',
      name: tool.name,
      description: tool.description,
      typeLabel: tool.kind === 'built-in' ? 'Tool' : 'MCP tool',
      status: missingCredentials ? 'blocked' : tool.enabled === false ? 'disabled' : 'active',
      source: tool.source === 'custom' ? 'Custom capability' : tool.origin === 'opencode' ? 'OpenCode runtime' : 'Built-in capability',
      owner: tool.scope || tool.origin || null,
      provider: tool.integrationId || tool.namespace || null,
      model: tool.authMode || null,
      skillsCount: linkedSkills.length,
      toolsCount: methodsCount,
      capabilitiesCount: methodsCount + linkedSkills.length,
      lastUsedAt: null,
      lastRunAt: null,
      activeRuns: 0,
      failedRuns: 0,
      costUsd: null,
      tokenCount: null,
      reviewBacklog: 0,
      approvalBacklog: missingCredentials ? 1 : 0,
      tags: compact([
        tool.kind,
        tool.source,
        tool.origin,
        tool.scope,
        tool.authMode && `auth ${tool.authMode}`,
        missingCredentials && 'missing credentials',
      ]),
      bulkActions: [
        action('open_dependency', 'Open dependency drill-down', true, undefined, { selection: 'single' }),
        action('tag', 'Tag selected', false, 'Capability tags need a registry-backed metadata service before bulk use.'),
        action('untag', 'Untag selected', false, 'Capability tags need a registry-backed metadata service before bulk use.'),
      ],
      metadata: {
        capabilityType: 'tool',
        capabilityId: tool.id,
        integrationId: tool.integrationId || null,
      },
      searchValues: [
        tool.id,
        tool.namespace || '',
        ...tool.patterns,
        ...tool.agentNames,
        ...linkedSkills.flatMap((skill) => [skill.name, skill.label]),
        ...(tool.availableTools || []).flatMap((entry) => [entry.id, entry.description]),
      ],
    })
  })

  const skillItems = input.skills.map((skill) => {
    const linkedTools = input.tools.filter((tool) => (skill.toolIds || []).includes(tool.id))
    return registryItem({
      id: `capability:skill:${skill.name}`,
      kind: 'capability',
      name: skill.label || skill.name,
      description: skill.description,
      typeLabel: 'Skill',
      status: 'active',
      source: skill.source === 'custom' ? 'Custom capability' : 'Built-in capability',
      owner: skill.scope || skill.origin || null,
      provider: null,
      model: null,
      skillsCount: 1,
      toolsCount: linkedTools.length,
      capabilitiesCount: 1 + linkedTools.length,
      lastUsedAt: null,
      lastRunAt: null,
      activeRuns: 0,
      failedRuns: 0,
      costUsd: null,
      tokenCount: null,
      reviewBacklog: 0,
      approvalBacklog: 0,
      tags: compact(['skill', skill.source, skill.origin, skill.scope, linkedTools.length === 0 && 'standalone']),
      bulkActions: [
        action('open_dependency', 'Open dependency drill-down', true, undefined, { selection: 'single' }),
        action('tag', 'Tag selected', false, 'Capability tags need a registry-backed metadata service before bulk use.'),
        action('untag', 'Untag selected', false, 'Capability tags need a registry-backed metadata service before bulk use.'),
      ],
      metadata: {
        capabilityType: 'skill',
        capabilityId: skill.name,
        location: skill.location || null,
      },
      searchValues: [
        skill.name,
        skill.location || '',
        ...skill.agentNames,
        ...(skill.toolIds || []),
        ...linkedTools.flatMap((tool) => [tool.id, tool.name]),
      ],
    })
  })

  return [...toolItems, ...skillItems]
}

export function filterFleetRegistryItems(
  items: readonly FleetRegistryItem[],
  options: { query?: string; quickFilter?: FleetRegistryQuickFilter } = {},
) {
  const query = (options.query || '').trim().toLowerCase()
  const quickFilter = options.quickFilter || 'all'
  return items.filter((item) => {
    if (query && !item.searchText.includes(query)) return false
    if (quickFilter === 'all') return true
    if (quickFilter === 'active') return item.status === 'active' || item.status === 'ready' || item.status === 'running'
    if (quickFilter === 'paused') return item.status === 'paused'
    if (quickFilter === 'failing') return item.status === 'failed' || item.status === 'blocked' || item.failedRuns > 0
    if (quickFilter === 'unused') return !item.lastRunAt && !item.lastUsedAt && item.activeRuns === 0 && item.failedRuns === 0
    if (quickFilter === 'expensive') return (item.costUsd || 0) >= 1 || (item.tokenCount || 0) >= 100_000
    if (quickFilter === 'missing_credentials') return item.tags.some((tag) => tag.toLowerCase().includes('missing credentials'))
    if (quickFilter === 'waiting_review') return item.status === 'waiting_review' || item.reviewBacklog + item.approvalBacklog > 0
    if (quickFilter === 'custom_only') return item.source.toLowerCase().includes('custom') || item.tags.includes('custom')
    if (quickFilter === 'builtin_runtime') {
      const source = item.source.toLowerCase()
      return source.includes('built-in') || source.includes('runtime') || source.includes('opencode')
    }
    return true
  })
}

export function sortFleetRegistryItems(items: readonly FleetRegistryItem[], sort: FleetRegistrySort = DEFAULT_FLEET_REGISTRY_SORT) {
  const direction = sort.direction === 'desc' ? -1 : 1
  return [...items].sort((left, right) => {
    const compared = compareSortValue(sortValue(left, sort.key), sortValue(right, sort.key))
    if (compared !== 0) return compared * direction
    return left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  })
}

function sortValue(item: FleetRegistryItem, key: FleetRegistrySortKey) {
  if (key === 'name') return item.name
  if (key === 'kind') return item.typeLabel
  if (key === 'status') return item.statusLabel
  if (key === 'source') return item.source
  if (key === 'model') return item.model || item.provider || ''
  if (key === 'capabilities') return item.capabilitiesCount
  if (key === 'activity') return dateValue(item.lastRunAt || item.lastUsedAt || (typeof item.metadata?.updatedAt === 'string' ? item.metadata.updatedAt : null))
  if (key === 'runs') return item.activeRuns * 1000 + item.failedRuns
  if (key === 'backlog') return item.reviewBacklog + item.approvalBacklog
  if (key === 'cost') return item.costUsd || 0
  if (key === 'tokens') return item.tokenCount || 0
  return item.name
}

function compareSortValue(left: string | number, right: string | number) {
  if (typeof left === 'number' && typeof right === 'number') return left - right
  return String(left).localeCompare(String(right), undefined, { sensitivity: 'base', numeric: true })
}

function dateValue(value: string | null | undefined) {
  if (!value) return 0
  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

function groupBy<T>(items: readonly T[], key: (item: T) => string) {
  const grouped = new Map<string, T[]>()
  for (const item of items) {
    const groupKey = key(item)
    const list = grouped.get(groupKey) || []
    list.push(item)
    grouped.set(groupKey, list)
  }
  return grouped
}

function runtimeMethodCount(tool: CapabilityTool, runtimeTools: readonly RuntimeToolDescriptor[]) {
  const prefixes = compact([
    tool.namespace && `mcp__${tool.namespace}__`,
    tool.namespace && `${tool.namespace}_`,
    `mcp__${tool.id}__`,
    `${tool.id}_`,
  ])
  const runtimeCount = runtimeTools.filter((entry) => {
    const id = entry.id || entry.name || ''
    return id === tool.id || prefixes.some((prefix) => id.startsWith(prefix))
  }).length
  return runtimeCount || tool.availableTools?.length || 0
}
