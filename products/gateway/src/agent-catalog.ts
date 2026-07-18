import * as fs from 'node:fs'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  agentProfileRevision,
  getConfig,
  getConfigDir,
  getConfigPath,
  type AgentProfile,
  type AgentTeamConfig,
  type GatewayConfig,
} from './config.js'
import { previewBlueprint, type BlueprintDefinition, type BlueprintPreview, type BlueprintValidationIssue } from './blueprints.js'
import { type WorkState } from './work-store.js'
import { getPromotionState, type PromotionSubjectKind } from './work-store/promotions.js'
import {
  inspectProfileAccess,
  inspectTeamAccess,
  type AccessInspection,
} from './access-inspection.js'
import {
  buildChannelConnectorRegistry,
  type ChannelConnectorRegistry,
  type ChannelConnectorStatus,
} from './channel-connectors.js'

export type AgentCatalogStatus = 'valid' | 'warning' | 'blocked'
export type LocalReadinessStatus = 'supported' | 'partial' | 'waived' | 'blocked' | 'unknown'
export type LocalReadinessCategory = 'runtime' | 'channel' | 'mcp' | 'setup_probe'

export interface LocalReadinessCapability {
  id: string
  label: string
  status: LocalReadinessStatus
  summary: string
  remediation?: string
}

export interface LocalReadinessEntry {
  id: string
  category: LocalReadinessCategory
  label: string
  status: LocalReadinessStatus
  statusCode: string
  summary: string
  remediation?: string
  capabilities: LocalReadinessCapability[]
  evidenceRefs: string[]
  redacted: true
}

export interface LocalReadinessCatalog {
  mode: 'local_readiness_catalog_v1'
  generatedAt: string
  entries: LocalReadinessEntry[]
  totals: Record<LocalReadinessStatus, number>
  releaseClaimBoundary: {
    current: 'local_operator_readiness_catalog'
    blockedClaims: string[]
  }
  redaction: {
    providerSecrets: 'excluded'
    channelTargetIds: 'redacted_or_hashed'
    transcripts: 'excluded'
    paths: 'local_config_refs_only'
  }
}

export interface AgentCatalogPermissionSummary {
  allow: number
  ask: number
  deny: number
  allowed: string[]
  risky: string[]
}

export interface AgentCatalogCapabilitySummary {
  skills: string[]
  mcpServers: string[]
  tools: string[]
  capabilities: string[]
  permissions: AgentCatalogPermissionSummary
}

export interface AgentCatalogPromotionSummary {
  state: string
  scorecardId?: string
  recommendation?: string
  decisionId?: string
  updatedAt?: string
}

export interface AgentCatalogProfileEntry {
  id: string
  kind: 'profile'
  name: string
  version: string
  revision: string
  description?: string
  model: string
  agent: string
  role: string
  status: AgentCatalogStatus
  source: AgentCatalogSource
  lastUpdatedAt?: string
  summary: AgentCatalogCapabilitySummary
  promotion: AgentCatalogPromotionSummary
  inspection: AccessInspection
  warnings: string[]
}

export interface AgentCatalogTeamEntry {
  id: string
  kind: 'team'
  name: string
  version: string
  revision: string
  description?: string
  status: AgentCatalogStatus
  source: AgentCatalogSource
  lastUpdatedAt?: string
  roles: Array<{ stage: string; profile: string; agent?: string; model?: string; role?: string }>
  capabilityRequirements: Array<{ stage: string; capabilities: string[] }>
  qualitySpecDefaultKeys: string[]
  references: { roadmaps: number; tasks: number; activeTasks: number; recentRuns: number }
  summary: AgentCatalogCapabilitySummary
  promotion: AgentCatalogPromotionSummary
  inspection: AccessInspection
  warnings: string[]
}

export interface AgentCatalogBlueprintEntry {
  id: string
  kind: 'blueprint'
  name: string
  version: string
  revision?: string
  title?: string
  description?: string
  owner?: string
  tags: string[]
  status: AgentCatalogStatus
  source: AgentCatalogSource
  lastUpdatedAt?: string
  profiles: string[]
  teams: string[]
  requiredOpenCode: Required<NonNullable<BlueprintDefinition['requiredOpenCode']>>
  summary: AgentCatalogCapabilitySummary
  validation: { errors: BlueprintValidationIssue[]; warnings: BlueprintValidationIssue[] }
  diffSummary: Record<string, number>
  promotion: { state: 'not_tracked'; updatedAt?: string }
  warnings: string[]
}

export interface AgentCatalogSource {
  type: 'config' | 'blueprint_file'
  path?: string
}

export interface AgentCatalogSourceState {
  path: string
  status: 'ok' | 'missing' | 'error'
  count: number
  error?: string
}

export interface AgentCatalog {
  generatedAt: string
  sources: {
    config?: string
    blueprints: AgentCatalogSourceState[]
  }
  profiles: AgentCatalogProfileEntry[]
  teams: AgentCatalogTeamEntry[]
  blueprints: AgentCatalogBlueprintEntry[]
  localReadiness: LocalReadinessCatalog
  errors: Array<{ path: string; message: string }>
  totals: {
    profiles: number
    teams: number
    blueprints: number
    blocked: number
    warnings: number
  }
}

export interface AgentCatalogOptions {
  config?: GatewayConfig
  workState?: Pick<WorkState, 'roadmaps' | 'tasks' | 'runs'>
  blueprintDirs?: string[]
  now?: Date
  localReadiness?: LocalReadinessCatalogOptions
}

export interface LocalReadinessCatalogOptions {
  config?: GatewayConfig
  generatedAt?: string
  connectorRegistry?: ChannelConnectorRegistry
  opencode?: { status: 'pass' | 'warn' | 'fail'; summary: string }
  heartbeat?: {
    status?: string
    lastCompletedAt?: string
    lastError?: string
    running?: boolean
    enabled?: boolean
    intervalMs?: number
  }
}

export function buildAgentCatalog(options: AgentCatalogOptions = {}): AgentCatalog {
  const config = options.config || getConfig()
  const generatedAt = (options.now || new Date()).toISOString()
  const configUpdatedAt = fileUpdatedAt(getConfigPath())
  const blueprintLibrary = loadBlueprintLibrary(config, options.blueprintDirs)
  const profiles = buildProfileCatalog(config, configUpdatedAt)
  const teams = buildTeamCatalog(config, options.workState, configUpdatedAt)
  const blueprints = blueprintLibrary.entries
  const localReadiness = buildLocalReadinessCatalog({ ...options.localReadiness, config, generatedAt })
  const warnings = profiles.filter(row => row.status === 'warning').length
    + teams.filter(row => row.status === 'warning').length
    + blueprints.filter(row => row.status === 'warning').length
  const blocked = profiles.filter(row => row.status === 'blocked').length
    + teams.filter(row => row.status === 'blocked').length
    + blueprints.filter(row => row.status === 'blocked').length

  return {
    generatedAt,
    sources: { config: getConfigPath(), blueprints: blueprintLibrary.sources },
    profiles,
    teams,
    blueprints,
    localReadiness,
    errors: blueprintLibrary.errors,
    totals: {
      profiles: profiles.length,
      teams: teams.length,
      blueprints: blueprints.length,
      blocked,
      warnings,
    },
  }
}

export function buildLocalReadinessCatalog(options: LocalReadinessCatalogOptions = {}): LocalReadinessCatalog {
  const config = options.config || getConfig()
  const generatedAt = options.generatedAt || new Date().toISOString()
  const connectorRegistry = options.connectorRegistry || safeChannelConnectorRegistry(config, generatedAt)
  const entries = [
    runtimeEntry(config, options.opencode),
    heartbeatEntry(config, generatedAt, options.heartbeat),
    channelCredentialsEntry(connectorRegistry.connectors),
    providerCapabilitiesEntry(connectorRegistry.connectors),
    mcpSurfaceEntry(config),
    ...connectorRegistry.connectors.map(channelEntry),
  ].sort((a, b) => categorySort(a.category, b.category) || a.id.localeCompare(b.id))

  return {
    mode: 'local_readiness_catalog_v1',
    generatedAt,
    entries,
    totals: readinessTotals(entries),
    releaseClaimBoundary: {
      current: 'local_operator_readiness_catalog',
      blockedClaims: [
        'hosted onboarding',
        'remote plugin loading',
        'marketplace readiness',
        'universal channel readiness without live proof',
        'WhatsApp live readiness',
        'Discord live readiness',
        'arbitrary-scale readiness',
      ],
    },
    redaction: {
      providerSecrets: 'excluded',
      channelTargetIds: 'redacted_or_hashed',
      transcripts: 'excluded',
      paths: 'local_config_refs_only',
    },
  }
}

export function listBlueprintCatalogDirs(config: GatewayConfig = getConfig()): string[] {
  const defaultDir = path.join(getConfigDir(), 'blueprints')
  const configured = (config.agentFactory?.blueprintDirs || []).map(dir => path.resolve(getConfigDir(), dir))
  return [...new Set([defaultDir, ...configured])]
}

function buildProfileCatalog(config: GatewayConfig, configUpdatedAt?: string): AgentCatalogProfileEntry[] {
  return Object.entries(config.profiles || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, profile]) => {
    const revision = agentProfileRevision(profile)
    const promotion = compactPromotionState('profile', name)
    const summary = profileCapabilitySummary(profile)
    const inspection = inspectProfileAccess(name, profile, { config })
    const warnings = inspectionWarnings(inspection, promotion)
    return {
      id: `profile:${name}`,
      kind: 'profile',
      name,
      version: profile.version || `rev:${revision}`,
      revision,
      description: profile.description,
      model: `${profile.model.providerID}/${profile.model.modelID}${profile.model.variant ? `:${profile.model.variant}` : ''}`,
      agent: profile.agent,
      role: profile.role,
      status: statusFromInspection(promotion.state, inspection, warnings),
      source: { type: 'config', path: getConfigPath() },
      lastUpdatedAt: profile.updatedAt || configUpdatedAt,
      summary,
      promotion,
      inspection,
      warnings,
    }
  })
}

function buildTeamCatalog(config: GatewayConfig, workState: AgentCatalogOptions['workState'], configUpdatedAt?: string): AgentCatalogTeamEntry[] {
  const references = teamReferenceMap(config, workState)
  return Object.entries(config.agentTeams || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, team]) => {
    const promotion = compactPromotionState('team', name)
    const roles = Object.entries(team.roles || {}).sort(([a], [b]) => stageSort(a, b)).map(([stage, profileName]) => {
      const profile = config.profiles[profileName]
      return {
        stage,
        profile: profileName,
        agent: profile?.agent,
        model: profile ? `${profile.model.providerID}/${profile.model.modelID}` : undefined,
        role: profile?.role,
      }
    })
    const summary = teamCapabilitySummary(team, config.profiles)
    const inspection = inspectTeamAccess(name, team, { config })
    const warnings = inspectionWarnings(inspection, promotion)
    return {
      id: `team:${name}`,
      kind: 'team',
      name,
      version: team.version || `rev:${team.revision}`,
      revision: team.revision,
      description: team.description,
      status: statusFromInspection(promotion.state, inspection, warnings),
      source: { type: 'config', path: getConfigPath() },
      lastUpdatedAt: team.updatedAt || configUpdatedAt,
      roles,
      capabilityRequirements: Object.entries(team.capabilityRequirements || {}).sort(([a], [b]) => stageSort(a, b)).map(([stage, capabilities]) => ({ stage, capabilities })),
      qualitySpecDefaultKeys: Object.keys(team.qualitySpecDefaults || {}).sort(),
      references: references.get(name) || { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 },
      summary,
      promotion,
      inspection,
      warnings,
    }
  })
}

function loadBlueprintLibrary(config: GatewayConfig, explicitDirs?: string[]): { entries: AgentCatalogBlueprintEntry[]; sources: AgentCatalogSourceState[]; errors: Array<{ path: string; message: string }> } {
  const dirs = explicitDirs?.length ? explicitDirs.map(dir => path.resolve(getConfigDir(), dir)) : listBlueprintCatalogDirs(config)
  const sources: AgentCatalogSourceState[] = []
  const errors: Array<{ path: string; message: string }> = []
  const entries: AgentCatalogBlueprintEntry[] = []

  for (const dir of [...new Set(dirs)].sort()) {
    if (!fs.existsSync(dir)) {
      sources.push({ path: dir, status: 'missing', count: 0 })
      continue
    }
    try {
      const files = fs.readdirSync(dir)
        .filter(file => file.endsWith('.json'))
        .map(file => path.join(dir, file))
        .sort()
      sources.push({ path: dir, status: 'ok', count: files.length })
      for (const file of files) entries.push(readBlueprintCatalogEntry(file, config, errors))
    } catch (err: any) {
      const message = err?.message || String(err)
      sources.push({ path: dir, status: 'error', count: 0, error: message })
      errors.push({ path: dir, message })
    }
  }

  return {
    entries: entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version) || (a.source.path || '').localeCompare(b.source.path || '')),
    sources,
    errors,
  }
}

function readBlueprintCatalogEntry(file: string, config: GatewayConfig, errors: Array<{ path: string; message: string }>): AgentCatalogBlueprintEntry {
  const lastUpdatedAt = fileUpdatedAt(file)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('blueprint file must contain a JSON object')
    const definition = parsed as BlueprintDefinition
    const preview = previewBlueprint(definition, config)
    return blueprintEntryFromPreview(definition, preview, file, lastUpdatedAt)
  } catch (err: any) {
    const message = err?.message || String(err)
    errors.push({ path: file, message })
    const name = path.basename(file, '.json') || shortHash(file)
    return {
      id: `blueprint:${name}@invalid`,
      kind: 'blueprint',
      name,
      version: 'invalid',
      status: 'blocked',
      source: { type: 'blueprint_file', path: file },
      lastUpdatedAt,
      tags: [],
      profiles: [],
      teams: [],
      requiredOpenCode: { agents: [], skills: [], mcpServers: [], tools: [] },
      summary: emptyCapabilitySummary(),
      validation: { errors: [{ severity: 'error', code: 'invalid_blueprint_file', path: file, message }], warnings: [] },
      diffSummary: {},
      promotion: { state: 'not_tracked', updatedAt: lastUpdatedAt },
      warnings: [message],
    }
  }
}

function blueprintEntryFromPreview(definition: BlueprintDefinition, preview: BlueprintPreview, file: string, fileUpdatedAtValue?: string): AgentCatalogBlueprintEntry {
  const requiredOpenCode = preview.normalized.requiredOpenCode
  const metadata = preview.blueprint.metadata || definition.metadata || {}
  const summary = blueprintCapabilitySummary(definition, requiredOpenCode)
  const warnings = [
    ...preview.validation.warnings.map(issue => issue.message),
    ...preview.validation.errors.map(issue => issue.message),
  ]
  return {
    id: `blueprint:${preview.blueprint.name}@${preview.blueprint.version}`,
    kind: 'blueprint',
    name: preview.blueprint.name,
    version: preview.blueprint.version,
    revision: preview.blueprint.revision,
    title: metadata.title,
    description: metadata.description,
    owner: metadata.owner,
    tags: [...new Set(metadata.tags || [])].sort(),
    status: preview.validation.errors.length ? 'blocked' : preview.validation.warnings.length ? 'warning' : 'valid',
    source: { type: 'blueprint_file', path: file },
    lastUpdatedAt: metadata.updatedAt || fileUpdatedAtValue,
    profiles: Object.keys(preview.normalized.profiles).sort(),
    teams: Object.keys(preview.normalized.teams).sort(),
    requiredOpenCode,
    summary,
    validation: preview.validation,
    diffSummary: countDiffActions(preview.diff),
    promotion: { state: 'not_tracked', updatedAt: metadata.updatedAt || fileUpdatedAtValue },
    warnings,
  }
}

function profileCapabilitySummary(profile: AgentProfile): AgentCatalogCapabilitySummary {
  return {
    skills: [...(profile.skills || [])].sort(),
    mcpServers: [...(profile.mcpServers || [])].sort(),
    tools: [...(profile.tools || [])].sort(),
    capabilities: [...(profile.capabilities || [])].sort(),
    permissions: permissionSummary(profile.permission || {}),
  }
}

function teamCapabilitySummary(team: AgentTeamConfig, profiles: Record<string, AgentProfile>): AgentCatalogCapabilitySummary {
  const skills = new Set<string>()
  const mcpServers = new Set<string>()
  const tools = new Set<string>()
  const capabilities = new Set<string>()
  const permissions: Record<string, string> = {}

  for (const profileName of Object.values(team.roles || {})) {
    const profile = profiles[profileName]
    if (!profile) continue
    for (const skill of profile.skills || []) skills.add(skill)
    for (const server of profile.mcpServers || []) mcpServers.add(server)
    for (const tool of profile.tools || []) tools.add(tool)
    for (const capability of profile.capabilities || []) capabilities.add(capability)
    for (const [key, policy] of Object.entries(profile.permission || {})) {
      if (permissions[key] !== 'allow') permissions[key] = policy
    }
  }
  for (const values of Object.values(team.capabilityRequirements || {})) {
    for (const capability of values) capabilities.add(capability)
  }

  return {
    skills: [...skills].sort(),
    mcpServers: [...mcpServers].sort(),
    tools: [...tools].sort(),
    capabilities: [...capabilities].sort(),
    permissions: permissionSummary(permissions),
  }
}

function blueprintCapabilitySummary(definition: BlueprintDefinition, requiredOpenCode: Required<NonNullable<BlueprintDefinition['requiredOpenCode']>>): AgentCatalogCapabilitySummary {
  const skills = new Set(requiredOpenCode.skills)
  const mcpServers = new Set(requiredOpenCode.mcpServers)
  const tools = new Set(requiredOpenCode.tools)
  const capabilities = new Set<string>()
  const permission: Record<string, string> = {}

  for (const profile of Object.values(definition.profiles || {})) {
    for (const skill of profile.skills || []) skills.add(skill)
    for (const server of profile.mcpServers || []) mcpServers.add(server)
    for (const tool of profile.tools || []) tools.add(tool)
    for (const capability of profile.capabilities || []) capabilities.add(capability)
    mergePermissions(permission, profile.permission || {})
  }
  for (const scopedPermission of Object.values(definition.permissions || {})) {
    mergePermissions(permission, scopedPermission || {})
  }
  for (const team of Object.values(definition.teams || {})) {
    for (const values of Object.values(team.capabilityRequirements || {})) {
      for (const capability of values || []) capabilities.add(capability)
    }
  }

  return {
    skills: [...skills].sort(),
    mcpServers: [...mcpServers].sort(),
    tools: [...tools].sort(),
    capabilities: [...capabilities].sort(),
    permissions: permissionSummary(permission),
  }
}

function permissionSummary(permission: Record<string, string>): AgentCatalogPermissionSummary {
  const summary: AgentCatalogPermissionSummary = { allow: 0, ask: 0, deny: 0, allowed: [], risky: [] }
  for (const [key, policy] of Object.entries(permission).sort(([a], [b]) => a.localeCompare(b))) {
    if (policy === 'allow' || policy === 'ask' || policy === 'deny') summary[policy] += 1
    if (policy === 'allow') {
      const label = key || '(default)'
      summary.allowed.push(label)
      if (isRiskyPermission(label)) summary.risky.push(label)
    }
  }
  return summary
}

function mergePermissions(target: Record<string, string>, permission: Record<string, string>): void {
  for (const [key, policy] of Object.entries(permission)) target[key] = strongestPermissionPolicy(target[key], policy)
}

function strongestPermissionPolicy(a: string | undefined, b: string): string {
  const rank = (policy: string | undefined) => policy === 'allow' ? 3 : policy === 'ask' ? 2 : policy === 'deny' ? 1 : 0
  return rank(b) > rank(a) ? b : (a || b)
}

function emptyCapabilitySummary(): AgentCatalogCapabilitySummary {
  return { skills: [], mcpServers: [], tools: [], capabilities: [], permissions: { allow: 0, ask: 0, deny: 0, allowed: [], risky: [] } }
}

function compactPromotionState(subjectKind: PromotionSubjectKind, subjectName: string): AgentCatalogPromotionSummary {
  try {
    const promotion = getPromotionState(subjectKind, subjectName)
    return {
      state: promotion.state,
      scorecardId: promotion.scorecard?.id,
      recommendation: promotion.scorecard?.recommendation,
      decisionId: promotion.decision?.id,
      updatedAt: promotion.decision?.updatedAt || promotion.scorecard?.updatedAt,
    }
  } catch {
    return { state: 'unknown' }
  }
}

function teamReferenceMap(config: GatewayConfig, workState: AgentCatalogOptions['workState']): Map<string, AgentCatalogTeamEntry['references']> {
  const map = new Map<string, AgentCatalogTeamEntry['references']>()
  const ensure = (team: string) => {
    let refs = map.get(team)
    if (!refs) {
      refs = { roadmaps: 0, tasks: 0, activeTasks: 0, recentRuns: 0 }
      map.set(team, refs)
    }
    return refs
  }
  const roadmapTeams = new Map<string, string>()
  for (const roadmap of workState?.roadmaps || []) {
    if (!roadmap.agentTeam || !config.agentTeams[roadmap.agentTeam]) continue
    roadmapTeams.set(roadmap.id, roadmap.agentTeam)
    ensure(roadmap.agentTeam).roadmaps += 1
  }
  for (const task of workState?.tasks || []) {
    const team = task.agentTeam || roadmapTeams.get(task.roadmapId)
    if (!team || !config.agentTeams[team]) continue
    const refs = ensure(team)
    refs.tasks += 1
    if (task.status === 'pending' || task.status === 'running' || task.status === 'blocked' || task.status === 'paused') refs.activeTasks += 1
  }
  for (const run of workState?.runs || []) {
    if (!run.agentTeam || !config.agentTeams[run.agentTeam]) continue
    ensure(run.agentTeam).recentRuns += 1
  }
  return map
}

function inspectionWarnings(inspection: AccessInspection, promotion: AgentCatalogPromotionSummary): string[] {
  const warnings = inspection.warnings.map(row => `${row.code}: ${row.message} Action: ${row.action}`)
  if (promotion.state === 'blocked' || promotion.state === 'deprecated') warnings.push(`promotion state is ${promotion.state}`)
  return warnings
}

function statusFromInspection(state: string, inspection: AccessInspection, warnings: string[]): AgentCatalogStatus {
  if (state === 'blocked' || inspection.status === 'blocked') return 'blocked'
  if (state === 'deprecated' || warnings.length) return 'warning'
  return 'valid'
}

function runtimeEntry(config: GatewayConfig, opencode?: LocalReadinessCatalogOptions['opencode']): LocalReadinessEntry {
  if (!String(config.opencodeUrl || '').trim()) {
    return readinessEntry({
      id: 'runtime:opencode',
      category: 'runtime',
      label: 'OpenCode runtime',
      status: 'blocked',
      statusCode: 'opencode_url_missing',
      summary: 'OpenCode URL is not configured.',
      remediation: 'Set opencodeUrl to the local OpenCode server and rerun doctor/readiness.',
      capabilities: [
        capability('server_health', 'OpenCode server health', 'blocked', 'No OpenCode URL is available for health checks.'),
      ],
      evidenceRefs: ['config:opencodeUrl'],
    })
  }
  if (!opencode) {
    return readinessEntry({
      id: 'runtime:opencode',
      category: 'runtime',
      label: 'OpenCode runtime',
      status: 'unknown',
      statusCode: 'opencode_health_not_probed',
      summary: 'OpenCode server URL is configured; live health is checked by readiness/doctor.',
      remediation: 'Run opencode-gateway readiness or doctor while the daemon can reach OpenCode.',
      capabilities: [
        capability('server_health', 'OpenCode server health', 'unknown', 'No live health result was supplied to the local catalog.'),
      ],
      evidenceRefs: ['config:opencodeUrl'],
    })
  }
  const status = opencode.status === 'pass' ? 'supported' : opencode.status === 'warn' ? 'partial' : 'blocked'
  return readinessEntry({
    id: 'runtime:opencode',
    category: 'runtime',
    label: 'OpenCode runtime',
    status,
    statusCode: opencode.status === 'pass' ? 'opencode_reachable' : opencode.status === 'warn' ? 'opencode_degraded' : 'opencode_unreachable',
    summary: opencode.summary,
    remediation: status === 'supported' ? undefined : 'Start opencode serve, verify the configured opencodeUrl, then rerun readiness.',
    capabilities: [
      capability('server_health', 'OpenCode server health', status, opencode.summary),
      capability('session_continuity', 'Session continuity', status === 'supported' ? 'supported' : 'unknown', status === 'supported' ? 'Gateway can ask OpenCode for Session state.' : 'Session continuity is unknown until OpenCode health passes.'),
    ],
    evidenceRefs: ['config:opencodeUrl', 'probe:opencode.global.health'],
  })
}

function heartbeatEntry(config: GatewayConfig, generatedAt: string, heartbeat?: LocalReadinessCatalogOptions['heartbeat']): LocalReadinessEntry {
  const intervalMs = config.scheduler.enabled ? Math.min(config.scheduler.intervalMs, config.heartbeat.intervalMs) : config.heartbeat.intervalMs
  const staleAfterMs = Math.max(intervalMs * 3, 5 * 60 * 1000)
  if (!heartbeat) {
    return readinessEntry({
      id: 'setup:daemon_heartbeat',
      category: 'setup_probe',
      label: 'Gateway daemon heartbeat',
      status: 'unknown',
      statusCode: 'heartbeat_not_probed',
      summary: 'Heartbeat state was not supplied to the local catalog.',
      remediation: 'Run doctor/readiness from the daemon process or inspect /readiness.',
      capabilities: [
        capability('scheduler_tick', 'Scheduler tick freshness', 'unknown', 'No heartbeat sample was available.'),
      ],
      evidenceRefs: ['probe:gateway.heartbeat'],
    })
  }
  if (heartbeat.status === 'error') {
    return readinessEntry({
      id: 'setup:daemon_heartbeat',
      category: 'setup_probe',
      label: 'Gateway daemon heartbeat',
      status: 'blocked',
      statusCode: 'heartbeat_error',
      summary: heartbeat.lastError || 'Gateway heartbeat is failing.',
      remediation: 'Inspect Gateway logs, fix the heartbeat error, then rerun readiness.',
      capabilities: [
        capability('scheduler_tick', 'Scheduler tick freshness', 'blocked', heartbeat.lastError || 'Heartbeat failed.'),
      ],
      evidenceRefs: ['probe:gateway.heartbeat'],
    })
  }
  const lastCompleted = Date.parse(heartbeat.lastCompletedAt || '')
  if (!Number.isFinite(lastCompleted)) {
    const running = heartbeat.running ? 'Heartbeat is running but has not completed yet.' : 'Heartbeat has not completed yet.'
    return readinessEntry({
      id: 'setup:daemon_heartbeat',
      category: 'setup_probe',
      label: 'Gateway daemon heartbeat',
      status: 'partial',
      statusCode: 'heartbeat_not_completed',
      summary: running,
      remediation: 'Wait for one scheduler/heartbeat interval or run a manual heartbeat, then rerun readiness.',
      capabilities: [
        capability('scheduler_tick', 'Scheduler tick freshness', 'partial', running),
      ],
      evidenceRefs: ['probe:gateway.heartbeat'],
    })
  }
  const reportTime = Date.parse(generatedAt)
  const ageMs = (Number.isFinite(reportTime) ? reportTime : Date.now()) - lastCompleted
  const stale = ageMs > staleAfterMs
  return readinessEntry({
    id: 'setup:daemon_heartbeat',
    category: 'setup_probe',
    label: 'Gateway daemon heartbeat',
    status: stale ? 'partial' : 'supported',
    statusCode: stale ? 'heartbeat_stale' : 'heartbeat_fresh',
    summary: stale ? `Heartbeat is stale by ${Math.round(ageMs / 1000)}s.` : 'Heartbeat has a fresh completion sample.',
    remediation: stale ? 'Restart or resume the daemon heartbeat before claiming live scheduler readiness.' : undefined,
    capabilities: [
      capability('scheduler_tick', 'Scheduler tick freshness', stale ? 'partial' : 'supported', stale ? 'Heartbeat is stale.' : 'Heartbeat is fresh.'),
    ],
    evidenceRefs: ['probe:gateway.heartbeat'],
  })
}

function channelCredentialsEntry(connectors: ChannelConnectorStatus[]): LocalReadinessEntry {
  const active = connectors.filter(hasOperatorIntent)
  const blocked = active.filter(connector => ['credentials_needed', 'blocked', 'webhook_needed', 'verification_pending', 'trusted_target_pending'].includes(connector.state))
  const partial = active.filter(connector => ['bound', 'degraded', 'provider_connected', 'polling_ready'].includes(connector.state))
  if (!active.length) {
    return readinessEntry({
      id: 'setup:channel_credentials',
      category: 'setup_probe',
      label: 'Channel credentials',
      status: 'waived',
      statusCode: 'channels_not_enabled',
      summary: 'No external channel connector is enabled or configured.',
      remediation: 'Enable a channel setup path only when you intend to run a live provider drill.',
      capabilities: connectors.map(connector => capability(`channel_${connector.provider}`, connector.displayName, 'waived', 'Connector is not enabled.')),
      evidenceRefs: ['config:channels'],
    })
  }
  const status: LocalReadinessStatus = blocked.length ? 'blocked' : partial.length ? 'partial' : 'supported'
  return readinessEntry({
    id: 'setup:channel_credentials',
    category: 'setup_probe',
    label: 'Channel credentials',
    status,
    statusCode: blocked.length ? 'channel_credentials_or_setup_blocked' : partial.length ? 'channel_setup_partial' : 'channel_credentials_ready',
    summary: blocked.length
      ? `${blocked.length} active channel connector(s) have blocking credential, setup, or security prerequisites.`
      : partial.length
        ? `${partial.length} active channel connector(s) still need trust, binding, or webhook completion.`
        : 'Active channel connectors have credentials and setup prerequisites satisfied.',
    remediation: status === 'supported' ? undefined : firstRemediation(blocked[0] || partial[0]),
    capabilities: active.map(connector => capability(`channel_${connector.provider}`, connector.displayName, channelStatus(connector), connector.stateSummary, firstRemediation(connector))),
    evidenceRefs: active.flatMap(connector => safeRefs(connector.evidenceRefs)),
  })
}

function providerCapabilitiesEntry(connectors: ChannelConnectorStatus[]): LocalReadinessEntry {
  const capabilities = connectors.flatMap(connector =>
    connectorCapabilities(connector).map(row => capability(`${connector.provider}_${row.id}`, `${connector.displayName} ${row.label}`, row.status, row.summary, row.remediation)),
  )
  const blocked = capabilities.filter(row => row.status === 'blocked')
  const partial = capabilities.filter(row => row.status === 'partial' || row.status === 'unknown')
  const waived = capabilities.filter(row => row.status === 'waived')
  const status: LocalReadinessStatus = blocked.length ? 'blocked' : partial.length ? 'partial' : waived.length === capabilities.length ? 'waived' : 'supported'
  return readinessEntry({
    id: 'setup:provider_capabilities',
    category: 'setup_probe',
    label: 'Provider capabilities',
    status,
    statusCode: blocked.length ? 'provider_capability_blocked' : partial.length ? 'provider_capability_partial_or_unknown' : status === 'waived' ? 'provider_capabilities_waived' : 'provider_capabilities_supported',
    summary: `${capabilities.length} provider capability row(s): ${capabilities.filter(row => row.status === 'supported').length} supported, ${partial.length} partial/unknown, ${waived.length} waived.`,
    remediation: partial.length ? 'Use fallback behavior for partial/unknown provider capabilities and avoid universal channel claims.' : undefined,
    capabilities,
    evidenceRefs: connectors.flatMap(connector => [`capabilities:${connector.provider}`, ...safeRefs(connector.evidenceRefs)]),
  })
}

function safeChannelConnectorRegistry(config: GatewayConfig, generatedAt: string): ChannelConnectorRegistry {
  try {
    return buildChannelConnectorRegistry({ config, generatedAt })
  } catch {
    return buildChannelConnectorRegistry({ config, generatedAt, bindings: [], activeClaimRefs: {} })
  }
}

function mcpSurfaceEntry(config: GatewayConfig): LocalReadinessEntry {
  const profiles = Object.entries(config.profiles || {})
  const profilesWithGatewayMcp = profiles.filter(([, profile]) => (profile.mcpServers || []).includes('gateway')).map(([name]) => name)
  const profilesWithGatewayTools = profiles.filter(([, profile]) => (profile.tools || []).some(tool => tool.startsWith('gateway'))).map(([name]) => name)
  const status: LocalReadinessStatus = profilesWithGatewayMcp.length && profilesWithGatewayTools.length ? 'supported' : profilesWithGatewayMcp.length || profilesWithGatewayTools.length ? 'partial' : 'blocked'
  return readinessEntry({
    id: 'mcp:gateway',
    category: 'mcp',
    label: 'Gateway MCP surface',
    status,
    statusCode: status === 'supported' ? 'gateway_mcp_available' : status === 'partial' ? 'gateway_mcp_partial' : 'gateway_mcp_missing',
    summary: status === 'supported'
      ? `${profilesWithGatewayMcp.length} profile(s) include the Gateway MCP server and ${profilesWithGatewayTools.length} profile(s) include Gateway tools.`
      : status === 'partial'
        ? 'Gateway MCP/tool access is only partially represented in configured profiles.'
        : 'No configured profile exposes Gateway MCP/tool access.',
    remediation: status === 'supported' ? undefined : 'Add the Gateway MCP server and scoped gateway tools to the relevant agent profile.',
    capabilities: [
      capability('mcp_server', 'MCP server access', profilesWithGatewayMcp.length ? 'supported' : 'blocked', profilesWithGatewayMcp.length ? 'Gateway MCP server is present in at least one profile.' : 'No profile includes the Gateway MCP server.'),
      capability('gateway_tools', 'Gateway tool access', profilesWithGatewayTools.length ? 'supported' : 'blocked', profilesWithGatewayTools.length ? 'Gateway tools are present in at least one profile.' : 'No profile includes Gateway tools.'),
    ],
    evidenceRefs: ['config:profiles.*.mcpServers', 'config:profiles.*.tools'],
  })
}

function channelEntry(connector: ChannelConnectorStatus): LocalReadinessEntry {
  const status = channelStatus(connector)
  const remediation = firstRemediation(connector)
  return readinessEntry({
    id: `channel:${connector.provider}`,
    category: 'channel',
    label: connector.displayName,
    status,
    statusCode: `channel_${connector.state}`,
    summary: connector.stateSummary,
    remediation: status === 'supported' || status === 'waived' ? undefined : remediation,
    capabilities: [
      capability('enabled', 'Connector enabled', connector.enabled ? 'supported' : 'waived', connector.enabled ? 'Connector is enabled.' : 'Connector is not enabled.'),
      capability('configured', 'Provider configuration', connector.configured ? 'supported' : connector.enabled ? 'blocked' : 'waived', connector.configured ? 'Provider configuration is present.' : connector.enabled ? 'Provider configuration is incomplete.' : 'Provider configuration is intentionally absent.'),
      capability('trusted', 'Trusted target policy', connector.trusted ? connector.unsafeAllowAll ? 'partial' : 'supported' : connector.enabled ? 'blocked' : 'waived', connector.trusted ? connector.unsafeAllowAll ? 'Unsafe allow-all trust is enabled.' : 'Explicit trust is present or not required.' : connector.enabled ? 'No trusted target is configured.' : 'Trust is waived until connector enablement.'),
      capability('bound', 'Session/project binding', connector.bindingCount > 0 ? 'supported' : connector.enabled ? 'partial' : 'waived', connector.bindingCount > 0 ? 'At least one binding exists.' : connector.enabled ? 'No Session/Project binding exists yet.' : 'Binding is waived until connector enablement.'),
    ],
    evidenceRefs: safeRefs(connector.evidenceRefs),
  })
}

function channelStatus(connector: ChannelConnectorStatus): LocalReadinessStatus {
  if (!hasOperatorIntent(connector)) return 'waived'
  if (connector.state === 'ready') return 'supported'
  if (connector.state === 'blocked' || connector.state === 'credentials_needed' || connector.state === 'webhook_needed' || connector.state === 'verification_pending' || connector.state === 'trusted_target_pending') return 'blocked'
  if (connector.state === 'not_configured') return connector.enabled ? 'blocked' : 'waived'
  if (connector.state === 'degraded' || connector.state === 'bound' || connector.state === 'provider_connected' || connector.state === 'polling_ready') return 'partial'
  return 'unknown'
}

function connectorCapabilities(connector: ChannelConnectorStatus): LocalReadinessCapability[] {
  if (!hasOperatorIntent(connector)) return [capability('baseline', 'Baseline provider capability', 'waived', 'Connector is not enabled or configured by the operator.')]
  const rows: LocalReadinessCapability[] = []
  for (const path of connector.setupPaths) {
    rows.push(capability(
      `setup_path_${path.key}`,
      path.label,
      path.implementationStatus === 'implemented' ? pathStatus(path.state) : path.configured ? 'blocked' : 'unknown',
      path.summary,
      path.implementationStatus === 'implemented' ? undefined : `Use an implemented setup path before claiming ${path.label} readiness.`,
    ))
  }
  for (const diagnostic of connector.diagnostics) {
    rows.push(capability(
      `diagnostic_${diagnostic.code}`,
      diagnostic.code,
      diagnostic.severity === 'blocked' ? 'blocked' : diagnostic.severity === 'warning' ? 'partial' : 'unknown',
      diagnostic.summary,
      diagnostic.remediation,
    ))
  }
  if (!rows.length) rows.push(capability('baseline', 'Baseline provider capability', channelStatus(connector), connector.stateSummary, firstRemediation(connector)))
  return rows
}

function pathStatus(state: string): LocalReadinessStatus {
  if (state === 'ready') return 'supported'
  if (['blocked', 'credentials_needed', 'webhook_needed', 'verification_pending', 'trusted_target_pending'].includes(state)) return 'blocked'
  if (['provider_connected', 'polling_ready', 'bound', 'degraded'].includes(state)) return 'partial'
  if (state === 'not_configured') return 'waived'
  return 'unknown'
}

function readinessEntry(input: Omit<LocalReadinessEntry, 'redacted' | 'evidenceRefs'> & { evidenceRefs?: string[] }): LocalReadinessEntry {
  return {
    ...input,
    summary: safeText(input.summary),
    ...(input.remediation ? { remediation: safeText(input.remediation) } : {}),
    capabilities: input.capabilities.map(row => ({
      ...row,
      summary: safeText(row.summary),
      ...(row.remediation ? { remediation: safeText(row.remediation) } : {}),
    })),
    evidenceRefs: safeRefs(input.evidenceRefs || []),
    redacted: true,
  }
}

function capability(id: string, label: string, status: LocalReadinessStatus, summary: string, remediation?: string): LocalReadinessCapability {
  return { id, label, status, summary, ...(remediation ? { remediation } : {}) }
}

function firstRemediation(connector?: ChannelConnectorStatus): string | undefined {
  if (!connector) return undefined
  return connector.missingPrerequisites[0]?.remediation
    || connector.diagnostics[0]?.remediation
    || connector.onboardingFlow.primaryAction.summary
}

function hasOperatorIntent(connector: ChannelConnectorStatus): boolean {
  return connector.bindingCount > 0
    || connector.configured
    || connector.credentials.some(credential => credential.configured)
    || connector.setupPaths.some(path => path.configured || (path.active && path.implementationStatus !== 'implemented'))
    || connector.unsafeAllowAll
}

function readinessTotals(entries: LocalReadinessEntry[]): Record<LocalReadinessStatus, number> {
  const totals: Record<LocalReadinessStatus, number> = { supported: 0, partial: 0, waived: 0, blocked: 0, unknown: 0 }
  for (const entry of entries) totals[entry.status] += 1
  return totals
}

function categorySort(a: LocalReadinessCategory, b: LocalReadinessCategory): number {
  const rank: Record<LocalReadinessCategory, number> = { runtime: 0, setup_probe: 1, channel: 2, mcp: 3 }
  return rank[a] - rank[b]
}

function safeRefs(refs: string[]): string[] {
  return [...new Set(refs.filter(Boolean).map(ref => {
    const safe = String(ref)
      .replace(/token:[^,\s]+/gi, 'token:[redacted]')
      .replace(/secret:[^,\s]+/gi, 'secret:[redacted]')
      .replace(/chatId:[^,\s]+/gi, 'chatId:[redacted]')
      .replace(/userId:[^,\s]+/gi, 'userId:[redacted]')
    return safe.length > 180 ? `${safe.slice(0, 177)}...` : safe
  }))].sort()
}

function safeText(value: string): string {
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/\b(?:EAAG|xox[baprs]-|sk-)[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\b(token|secret|authorization|bearer)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\b(chatId|userId|channelId|targetId):[^\s,]+/gi, '$1:[redacted]')
}

function countDiffActions(diff: BlueprintPreview['diff']): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of diff) counts[entry.action] = (counts[entry.action] || 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

function isRiskyPermission(key: string): boolean {
  const normalized = key.toLowerCase()
  return normalized === '*' || normalized.includes('credential') || normalized.includes('secret') || normalized.includes('token') || ['edit', 'bash', 'webfetch', 'websearch'].includes(normalized)
}

function fileUpdatedAt(file: string): string | undefined {
  try {
    return fs.statSync(file).mtime.toISOString()
  } catch {
    return undefined
  }
}

function stageSort(a: string, b: string): number {
  const order = ['default', 'plan', 'implement', 'review', 'verify', 'audit']
  const ai = order.indexOf(a)
  const bi = order.indexOf(b)
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b)
  return a.localeCompare(b)
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10)
}
