import { createHash } from 'node:crypto'
import {
  getConfig,
  writeConfig,
  agentProfileRevision,
  agentTeamRevision,
  validateAgentTeamConfig,
  validateProfileConfig,
  type AgentProfile,
  type AgentTeamConfig,
  type GatewayConfig,
} from './config.js'
import { resolveEnvironmentSpec } from './environments.js'
import { GATEWAY_AGENT_NAMES, GATEWAY_SKILL_NAMES } from './opencode-defaults.js'
import { listOpenCodeAgents, listOpenCodeMcp, listOpenCodeSkills, listOpenCodeTools } from './opencode-assets.js'
import { isGatewayMcpToolName } from './gateway-tools.js'

export interface BlueprintMetadata {
  title?: string
  description?: string
  owner?: string
  tags?: string[]
  createdAt?: string
  updatedAt?: string
}

export interface BlueprintRollbackMetadata {
  replaces?: string[]
  deprecates?: string[]
  rollbackTargets?: string[]
  notes?: string
}

export interface BlueprintOpenCodeRequirements {
  agents?: string[]
  skills?: string[]
  mcpServers?: string[]
  tools?: string[]
}

export interface BlueprintDefinition {
  name: string
  version: string
  metadata?: BlueprintMetadata
  profiles?: Record<string, AgentProfile>
  teams?: Record<string, Partial<AgentTeamConfig>>
  requiredOpenCode?: BlueprintOpenCodeRequirements
  expected?: BlueprintExpectedState
  permissions?: Record<string, Record<string, string>>
  environments?: string[]
  qualityDefaults?: Record<string, unknown>
  rollback?: BlueprintRollbackMetadata
}

export interface BlueprintExpectedState {
  profiles?: Record<string, string>
  teams?: Record<string, string>
}

export type BlueprintSeverity = 'error' | 'warning'

export interface BlueprintValidationIssue {
  severity: BlueprintSeverity
  code: string
  path: string
  message: string
}

export type BlueprintDiffAction = 'create' | 'update' | 'noop' | 'missing'
export type BlueprintDiffTarget = 'profile' | 'agentTeam' | 'opencodeAgent' | 'opencodeSkill' | 'opencodeMcp' | 'opencodeTool'

export interface BlueprintDiffEntry {
  target: BlueprintDiffTarget
  name: string
  action: BlueprintDiffAction
  before?: unknown
  after?: unknown
  beforeRevision?: string
  afterRevision?: string
  owner: 'gateway' | 'opencode'
  note?: string
}

export interface BlueprintRollbackRecord {
  target: 'profile' | 'agentTeam'
  name: string
  previousVersion?: string
  previousRevision?: string
  previous?: unknown
}

export interface BlueprintPreview {
  ok: boolean
  blueprint: {
    name: string
    version: string
    revision: string
    metadata?: BlueprintMetadata
    rollback?: BlueprintRollbackMetadata
  }
  normalized: {
    profiles: Record<string, AgentProfile>
    teams: Record<string, AgentTeamConfig>
    requiredOpenCode: Required<BlueprintOpenCodeRequirements>
  }
  validation: {
    errors: BlueprintValidationIssue[]
    warnings: BlueprintValidationIssue[]
  }
  diff: BlueprintDiffEntry[]
  rollback: BlueprintRollbackRecord[]
  apply: {
    mode: 'proposal'
    safe: boolean
    reason: string
  }
}

export interface BlueprintApplyResult {
  applied: boolean
  preview: BlueprintPreview
  profiles: Record<string, AgentProfile>
  agentTeams: Record<string, AgentTeamConfig>
  rollback: BlueprintRollbackRecord[]
  receipt: BlueprintApplyReceipt
}

export interface BlueprintApplyReceipt {
  id: string
  blueprint: {
    name: string
    version: string
    revision: string
  }
  appliedAt: string
  actor: string
  source: string
  auditEventId?: number
  gateId?: string
  changed: Array<{
    target: 'profile' | 'agentTeam'
    name: string
    action: BlueprintDiffAction
    beforeRevision?: string
    afterRevision?: string
  }>
  validation: {
    errors: number
    warnings: number
  }
}

export interface BlueprintApplyOptions {
  actor?: string
  source?: string
  gateId?: string
  now?: Date
  recordAudit?: (receipt: BlueprintApplyReceipt, preview: BlueprintPreview) => number
}

export function previewBlueprint(input: BlueprintDefinition, config: GatewayConfig = getConfig()): BlueprintPreview {
  const issues: BlueprintValidationIssue[] = []
  const name = normalizeIdentifier(input?.name, 'name', issues)
  const version = normalizeVersion(input?.version, 'version', issues)
  const requiredOpenCode = normalizeRequiredOpenCode(input.requiredOpenCode, issues)
  const metadata = normalizeMetadata(input.metadata, issues)
  const rollbackMetadata = normalizeRollback(input.rollback, issues)
  const expected = normalizeExpectedState(input.expected, issues)
  const profiles = stampPreviewProfileVersions(normalizeBlueprintProfiles(input.profiles || {}, issues), version)
  const profileScope = { ...config.profiles, ...profiles }
  const teams = stampPreviewTeamVersions(normalizeBlueprintTeams(input.teams || {}, profileScope, issues), version)

  validateBlueprintShape(input, issues)
  validateRequiredAssets(requiredOpenCode, issues)
  validateProfileReferences(profiles, requiredOpenCode, config, issues)
  validateTeamQualityDefaults(teams, input.qualityDefaults, issues)
  validateEnvironmentReferences(input.environments || [], profiles, config, issues)
  validateRollbackMetadata(rollbackMetadata, config, issues)
  validateExpectedState(expected, profiles, teams, config, issues)

  const diff = buildBlueprintDiff(profiles, teams, requiredOpenCode, config)
  const rollback = buildRollbackRecords(profiles, teams, config)
  const errors = issues.filter(issue => issue.severity === 'error')
  const warnings = issues.filter(issue => issue.severity === 'warning')

  return {
    ok: errors.length === 0,
    blueprint: {
      name,
      version,
      revision: blueprintRevision(blueprintRevisionInput(input, profiles, teams)),
      metadata,
      rollback: rollbackMetadata,
    },
    normalized: { profiles, teams, requiredOpenCode },
    validation: { errors, warnings },
    diff,
    rollback,
    apply: {
      mode: 'proposal',
      safe: errors.length === 0,
      reason: errors.length ? 'Blueprint has validation errors; apply is blocked.' : 'Gateway profile/team config can be applied after an approved human gate. OpenCode asset changes remain references/proposals.',
    },
  }
}

export function applyBlueprint(input: BlueprintDefinition, config: GatewayConfig = getConfig(), options: BlueprintApplyOptions = {}): BlueprintApplyResult {
  const preview = previewBlueprint(input, config)
  if (!preview.ok) {
    const first = preview.validation.errors[0]
    throw new Error(`blueprint validation failed${first ? `: ${first.path}: ${first.message}` : ''}`)
  }
  const appliedAt = (options.now || new Date()).toISOString()
  const stampedProfiles = Object.fromEntries(Object.entries(preview.normalized.profiles).map(([name, profile]) => [name, stampProfileMetadata(profile, preview.blueprint.version, appliedAt)]))
  const stampedTeams = Object.fromEntries(Object.entries(preview.normalized.teams).map(([name, team]) => [name, stampTeamMetadata(team, preview.blueprint.version, appliedAt)]))
  const nextConfig: GatewayConfig = {
    ...config,
    profiles: { ...config.profiles, ...stampedProfiles },
    agentTeams: { ...config.agentTeams, ...stampedTeams },
  }
  writeConfig(nextConfig)
  const profiles: Record<string, AgentProfile> = {}
  for (const name of Object.keys(stampedProfiles)) profiles[name] = getConfig().profiles[name]!
  const agentTeams: Record<string, AgentTeamConfig> = {}
  for (const name of Object.keys(stampedTeams)) agentTeams[name] = getConfig().agentTeams[name]!
  const receipt: BlueprintApplyReceipt = {
    id: `blueprint_apply:${preview.blueprint.name}:${preview.blueprint.version}:${preview.blueprint.revision}:${appliedAt}`,
    blueprint: preview.blueprint,
    appliedAt,
    actor: options.actor || 'gateway',
    source: options.source || 'local',
    gateId: options.gateId,
    changed: preview.diff
      .filter(entry => (entry.target === 'profile' || entry.target === 'agentTeam') && entry.action !== 'noop')
      .map(entry => ({
        target: entry.target as 'profile' | 'agentTeam',
        name: entry.name,
        action: entry.action,
        beforeRevision: entry.beforeRevision,
        afterRevision: entry.target === 'profile'
          ? agentProfileRevision(profiles[entry.name]!)
          : agentTeams[entry.name]?.revision,
      })),
    validation: {
      errors: preview.validation.errors.length,
      warnings: preview.validation.warnings.length,
    },
  }
  const auditEventId = options.recordAudit?.(receipt, preview)
  if (auditEventId !== undefined) receipt.auditEventId = auditEventId
  return { applied: true, preview, profiles, agentTeams, rollback: preview.rollback, receipt }
}

export function formatBlueprintPreview(preview: BlueprintPreview): string {
  const lines = [
    `Blueprint ${preview.blueprint.name}@${preview.blueprint.version}`,
    `Status: ${preview.ok ? 'valid' : 'blocked'} (${preview.validation.errors.length} error(s), ${preview.validation.warnings.length} warning(s))`,
    `Apply: ${preview.apply.mode} - ${preview.apply.reason}`,
  ]
  if (preview.validation.errors.length) {
    lines.push('', 'Errors:')
    for (const issue of preview.validation.errors) lines.push(`- ${issue.path}: ${issue.message}`)
  }
  if (preview.validation.warnings.length) {
    lines.push('', 'Warnings:')
    for (const issue of preview.validation.warnings) lines.push(`- ${issue.path}: ${issue.message}`)
  }
  lines.push('', 'Diff:')
  for (const entry of preview.diff) lines.push(`- [${entry.action}] ${entry.target}:${entry.name} (${entry.owner})${entry.note ? ` - ${entry.note}` : ''}`)
  if (preview.rollback.length) {
    lines.push('', 'Rollback records:')
    for (const row of preview.rollback) lines.push(`- ${row.target}:${row.name}${row.previousVersion ? ` version=${row.previousVersion}` : ''}${row.previousRevision ? ` revision=${row.previousRevision}` : ''}`)
  }
  return lines.join('\n')
}

function normalizeBlueprintProfiles(input: Record<string, AgentProfile>, issues: BlueprintValidationIssue[]): Record<string, AgentProfile> {
  const profiles: Record<string, AgentProfile> = {}
  for (const [name, profile] of Object.entries(input || {})) {
    const normalizedName = normalizeIdentifier(name, `profiles.${name}`, issues)
    validateRawDuplicateList((profile as any)?.skills, `profiles.${name}.skills`, issues)
    validateRawDuplicateList((profile as any)?.mcpServers, `profiles.${name}.mcpServers`, issues)
    validateRawDuplicateList((profile as any)?.tools, `profiles.${name}.tools`, issues)
    validateRawDuplicateList((profile as any)?.capabilities, `profiles.${name}.capabilities`, issues)
    try {
      profiles[normalizedName] = validateProfileConfig(normalizedName, profile)
    } catch (err: any) {
      addIssue(issues, 'error', 'invalid_profile', `profiles.${name}`, err?.message || String(err))
    }
  }
  return profiles
}

function normalizeBlueprintTeams(input: Record<string, Partial<AgentTeamConfig>>, profiles: Record<string, AgentProfile>, issues: BlueprintValidationIssue[]): Record<string, AgentTeamConfig> {
  const teams: Record<string, AgentTeamConfig> = {}
  for (const [name, team] of Object.entries(input || {})) {
    const normalizedName = normalizeIdentifier(name, `teams.${name}`, issues)
    try {
      teams[normalizedName] = validateAgentTeamConfig(normalizedName, team, profiles)
    } catch (err: any) {
      addIssue(issues, 'error', 'invalid_team', `teams.${name}`, err?.message || String(err))
    }
  }
  return teams
}

function normalizeRequiredOpenCode(input: BlueprintOpenCodeRequirements | undefined, issues: BlueprintValidationIssue[]): Required<BlueprintOpenCodeRequirements> {
  return {
    agents: normalizeIdentifierList(input?.agents || [], 'requiredOpenCode.agents', issues),
    skills: normalizeIdentifierList(input?.skills || [], 'requiredOpenCode.skills', issues),
    mcpServers: normalizeIdentifierList(input?.mcpServers || [], 'requiredOpenCode.mcpServers', issues),
    tools: normalizeIdentifierList(input?.tools || [], 'requiredOpenCode.tools', issues),
  }
}

function normalizeExpectedState(input: BlueprintExpectedState | undefined, issues: BlueprintValidationIssue[]): BlueprintExpectedState | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addIssue(issues, 'error', 'invalid_expected_state', 'expected', 'expected must be an object with profile/team revision maps')
    return undefined
  }
  return {
    profiles: normalizeRevisionMap(input.profiles, 'expected.profiles', issues),
    teams: normalizeRevisionMap(input.teams, 'expected.teams', issues),
  }
}

function normalizeRevisionMap(input: Record<string, string> | undefined, path: string, issues: BlueprintValidationIssue[]): Record<string, string> | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addIssue(issues, 'error', 'invalid_expected_state', path, 'must be an object mapping names to expected revisions')
    return undefined
  }
  const output: Record<string, string> = {}
  for (const [name, revision] of Object.entries(input)) {
    const normalizedName = normalizeIdentifier(name, `${path}.${name}`, issues)
    if (typeof revision !== 'string' || !revision.trim()) addIssue(issues, 'error', 'invalid_expected_state', `${path}.${name}`, 'expected revision must be a non-empty string')
    else output[normalizedName] = revision.trim()
  }
  return output
}

function validateBlueprintShape(input: BlueprintDefinition, issues: BlueprintValidationIssue[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addIssue(issues, 'error', 'invalid_blueprint', 'blueprint', 'blueprint must be an object')
    return
  }
  if (!Object.keys(input.profiles || {}).length && !Object.keys(input.teams || {}).length) {
    addIssue(issues, 'error', 'empty_blueprint', 'blueprint', 'blueprint must include at least one profile or team recipe')
  }
}

function validateRequiredAssets(required: Required<BlueprintOpenCodeRequirements>, issues: BlueprintValidationIssue[]): void {
  const installed = inspectOpenCodeAssets(issues)
  const gatewayAgents = new Set<string>(GATEWAY_AGENT_NAMES)
  const gatewaySkills = new Set<string>(GATEWAY_SKILL_NAMES)
  for (const agent of required.agents) {
    if (!installed.agents.has(agent) && !gatewayAgents.has(agent)) addIssue(issues, 'error', 'missing_opencode_agent', `requiredOpenCode.agents.${agent}`, `required OpenCode agent is not installed or Gateway-shipped: ${agent}`)
  }
  for (const skill of required.skills) {
    if (!installed.skills.has(skill) && !gatewaySkills.has(skill)) addIssue(issues, 'error', 'missing_opencode_skill', `requiredOpenCode.skills.${skill}`, `required OpenCode skill is not installed or Gateway-shipped: ${skill}`)
  }
  for (const mcp of required.mcpServers) {
    if (!installed.mcpServers.has(mcp) && mcp !== 'gateway') addIssue(issues, 'error', 'missing_opencode_mcp', `requiredOpenCode.mcpServers.${mcp}`, `required OpenCode MCP server is not configured: ${mcp}`)
  }
  for (const tool of required.tools) {
    if (!installed.tools.has(tool) && !isGatewayMcpToolName(tool)) addIssue(issues, 'error', 'missing_opencode_tool', `requiredOpenCode.tools.${tool}`, `required OpenCode tool is not installed or Gateway-owned: ${tool}`)
  }
}

function validateProfileReferences(profiles: Record<string, AgentProfile>, required: Required<BlueprintOpenCodeRequirements>, config: GatewayConfig, issues: BlueprintValidationIssue[]): void {
  const requiredAgents = new Set(required.agents)
  const requiredSkills = new Set(required.skills)
  const requiredMcp = new Set(required.mcpServers)
  const requiredTools = new Set(required.tools)
  const configuredEnvironmentNames = new Set(Object.keys(config.environments.environments || {}))

  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile.permission || !Object.keys(profile.permission).length) addIssue(issues, 'error', 'missing_permission', `profiles.${name}.permission`, 'profile must declare an explicit permission policy')
    if (!permissionAllows(profile.permission, 'read')) addIssue(issues, 'error', 'missing_permission', `profiles.${name}.permission.read`, 'profile must explicitly allow or ask for read access')
    validateUnsafePermissions(name, profile.permission, issues)
    if (!requiredAgents.has(profile.agent) && !(GATEWAY_AGENT_NAMES as readonly string[]).includes(profile.agent)) addIssue(issues, 'error', 'unresolved_agent_reference', `profiles.${name}.agent`, `profile agent is not listed in requiredOpenCode.agents: ${profile.agent}`)
    for (const skill of profile.skills || []) {
      if (!requiredSkills.has(skill) && !(GATEWAY_SKILL_NAMES as readonly string[]).includes(skill)) addIssue(issues, 'error', 'unresolved_skill_reference', `profiles.${name}.skills.${skill}`, `profile skill is not listed in requiredOpenCode.skills: ${skill}`)
    }
    for (const mcp of profile.mcpServers || []) {
      if (!requiredMcp.has(mcp) && mcp !== 'gateway') addIssue(issues, 'error', 'unresolved_mcp_reference', `profiles.${name}.mcpServers.${mcp}`, `profile MCP server is not listed in requiredOpenCode.mcpServers: ${mcp}`)
    }
    for (const tool of profile.tools || []) {
      if (!requiredTools.has(tool) && !isGatewayMcpToolName(tool)) addIssue(issues, 'error', 'unresolved_tool_reference', `profiles.${name}.tools.${tool}`, `profile tool is not listed in requiredOpenCode.tools: ${tool}`)
      if (tool.startsWith('gateway_') && !(profile.mcpServers || []).includes('gateway')) addIssue(issues, 'error', 'unresolved_tool_reference', `profiles.${name}.tools.${tool}`, 'Gateway MCP tool references require mcpServers to include gateway')
    }
    if (typeof profile.environment === 'string' && !configuredEnvironmentNames.has(profile.environment)) {
      addIssue(issues, 'error', 'missing_environment', `profiles.${name}.environment`, `profile environment references missing environment: ${profile.environment}`)
    }
  }
}

function validateExpectedState(expected: BlueprintExpectedState | undefined, profiles: Record<string, AgentProfile>, teams: Record<string, AgentTeamConfig>, config: GatewayConfig, issues: BlueprintValidationIssue[]): void {
  if (!expected) return
  for (const name of Object.keys(profiles)) {
    if (!expected.profiles || expected.profiles[name] === undefined) continue
    const current = config.profiles[name]
    const currentRevision = current ? agentProfileRevision(current) : 'missing'
    if (expected.profiles[name] !== currentRevision) addIssue(issues, 'error', 'version_conflict', `expected.profiles.${name}`, `profile ${name} changed since preview: expected ${expected.profiles[name]}, current ${currentRevision}`)
  }
  for (const name of Object.keys(teams)) {
    if (!expected.teams || expected.teams[name] === undefined) continue
    const currentRevision = config.agentTeams[name]?.revision || 'missing'
    if (expected.teams[name] !== currentRevision) addIssue(issues, 'error', 'version_conflict', `expected.teams.${name}`, `agent team ${name} changed since preview: expected ${expected.teams[name]}, current ${currentRevision}`)
  }
}

function validateUnsafePermissions(profileName: string, permission: Record<string, string>, issues: BlueprintValidationIssue[]): void {
  for (const [key, value] of Object.entries(permission)) {
    const normalized = key.toLowerCase()
    if (value !== 'allow') continue
    if (!normalized || normalized === '*' || normalized.includes('*')) {
      addIssue(issues, 'error', 'unsafe_permission', `profiles.${profileName}.permission.${key || '(default)'}`, `unsafe broad permission grant must not be allow: ${key || '(default)'}`)
    } else if (normalized.includes('credential') || normalized.includes('secret') || normalized.includes('token')) {
      addIssue(issues, 'error', 'unsafe_permission', `profiles.${profileName}.permission.${key}`, `unsafe permission grant must not be allow: ${key}`)
    } else if (['edit', 'bash', 'webfetch', 'websearch'].includes(normalized)) {
      addIssue(issues, 'warning', 'unsafe_permission', `profiles.${profileName}.permission.${key}`, `risky permission grant should be justified by profile purpose and human gates: ${key}=allow`)
    }
  }
}

function validateTeamQualityDefaults(teams: Record<string, AgentTeamConfig>, qualityDefaults: Record<string, unknown> | undefined, issues: BlueprintValidationIssue[]): void {
  if (qualityDefaults !== undefined && (!qualityDefaults || typeof qualityDefaults !== 'object' || Array.isArray(qualityDefaults))) {
    addIssue(issues, 'error', 'invalid_quality_defaults', 'qualityDefaults', 'qualityDefaults must be an object')
  }
  for (const [name, team] of Object.entries(teams)) {
    if (!team.qualitySpecDefaults || typeof team.qualitySpecDefaults !== 'object' || Array.isArray(team.qualitySpecDefaults)) {
      addIssue(issues, 'error', 'invalid_quality_defaults', `teams.${name}.qualitySpecDefaults`, 'team qualitySpecDefaults must be an object')
    }
  }
}

function validateEnvironmentReferences(environments: string[], profiles: Record<string, AgentProfile>, config: GatewayConfig, issues: BlueprintValidationIssue[]): void {
  for (const env of normalizeIdentifierList(environments, 'environments', issues)) {
    if (!config.environments.environments[env]) addIssue(issues, 'error', 'missing_environment', `environments.${env}`, `blueprint environment references missing environment: ${env}`)
  }
  for (const [name, profile] of Object.entries(profiles)) {
    if (!profile.environment) continue
    try {
      const resolution = resolveEnvironmentSpec({ profileEnvironment: profile.environment, config: config.environments, stage: 'blueprint-validation' })
      if (!resolution.ok) addIssue(issues, 'error', 'environment_gap', `profiles.${name}.environment`, resolution.reason)
    } catch (err: any) {
      addIssue(issues, 'error', 'environment_gap', `profiles.${name}.environment`, err?.message || String(err))
    }
  }
}

function validateRollbackMetadata(rollback: BlueprintRollbackMetadata | undefined, config: GatewayConfig, issues: BlueprintValidationIssue[]): void {
  for (const target of rollback?.rollbackTargets || []) {
    if (!config.agentTeams[target] && !config.profiles[target]) addIssue(issues, 'warning', 'rollback_target_missing', `rollback.rollbackTargets.${target}`, `rollback target does not currently exist: ${target}`)
  }
  for (const target of rollback?.deprecates || []) {
    if (!config.agentTeams[target] && !config.profiles[target]) addIssue(issues, 'warning', 'deprecation_target_missing', `rollback.deprecates.${target}`, `deprecation target does not currently exist: ${target}`)
  }
}

function buildBlueprintDiff(profiles: Record<string, AgentProfile>, teams: Record<string, AgentTeamConfig>, required: Required<BlueprintOpenCodeRequirements>, config: GatewayConfig): BlueprintDiffEntry[] {
  const diff: BlueprintDiffEntry[] = []
  for (const [name, profile] of Object.entries(profiles)) diff.push(configDiffEntry('profile', name, config.profiles[name], profile))
  for (const [name, team] of Object.entries(teams)) diff.push(configDiffEntry('agentTeam', name, config.agentTeams[name], team))
  const installed = inspectOpenCodeAssets([])
  for (const agent of required.agents) diff.push(assetDiffEntry('opencodeAgent', agent, installed.agents.has(agent) || (GATEWAY_AGENT_NAMES as readonly string[]).includes(agent)))
  for (const skill of required.skills) diff.push(assetDiffEntry('opencodeSkill', skill, installed.skills.has(skill) || (GATEWAY_SKILL_NAMES as readonly string[]).includes(skill)))
  for (const mcp of required.mcpServers) diff.push(assetDiffEntry('opencodeMcp', mcp, installed.mcpServers.has(mcp) || mcp === 'gateway'))
  for (const tool of required.tools) diff.push(assetDiffEntry('opencodeTool', tool, installed.tools.has(tool) || tool.startsWith('gateway_')))
  return diff
}

function configDiffEntry(target: 'profile' | 'agentTeam', name: string, before: unknown, after: unknown): BlueprintDiffEntry {
  const action = before === undefined ? 'create' : stableStringify(before) === stableStringify(after) ? 'noop' : 'update'
  return { target, name, action, before, after, beforeRevision: configRevision(target, before), afterRevision: configRevision(target, after), owner: 'gateway' }
}

function assetDiffEntry(target: Exclude<BlueprintDiffTarget, 'profile' | 'agentTeam'>, name: string, exists: boolean): BlueprintDiffEntry {
  return {
    target,
    name,
    action: exists ? 'noop' : 'missing',
    owner: 'opencode',
    note: exists ? 'reference satisfied; Gateway will not mutate OpenCode asset' : 'operator must install or upsert this OpenCode asset before use',
  }
}

function buildRollbackRecords(profiles: Record<string, AgentProfile>, teams: Record<string, AgentTeamConfig>, config: GatewayConfig): BlueprintRollbackRecord[] {
  const records: BlueprintRollbackRecord[] = []
  for (const name of Object.keys(profiles)) {
    const previous = config.profiles[name]
    if (previous) records.push({ target: 'profile', name, previous: previous, previousVersion: previous.promotionState })
  }
  for (const name of Object.keys(teams)) {
    const previous = config.agentTeams[name]
    if (previous) records.push({ target: 'agentTeam', name, previous, previousVersion: previous.version, previousRevision: previous.revision })
  }
  return records
}

function inspectOpenCodeAssets(issues: BlueprintValidationIssue[]): { agents: Set<string>; skills: Set<string>; mcpServers: Set<string>; tools: Set<string> } {
  try {
    return {
      agents: new Set(Object.keys(listOpenCodeAgents())),
      skills: new Set(listOpenCodeSkills().map(skill => skill.name)),
      mcpServers: new Set(Object.keys(listOpenCodeMcp())),
      tools: new Set(listOpenCodeTools().map(tool => tool.name)),
    }
  } catch (err: any) {
    addIssue(issues, 'warning', 'opencode_assets_uninspectable', 'requiredOpenCode', `OpenCode assets could not be inspected: ${err?.message || String(err)}`)
    return { agents: new Set(), skills: new Set(), mcpServers: new Set(), tools: new Set() }
  }
}

function normalizeIdentifier(value: unknown, path: string, issues: BlueprintValidationIssue[]): string {
  if (typeof value !== 'string') {
    addIssue(issues, 'error', 'invalid_identifier', path, 'must be a string')
    return ''
  }
  const text = value.trim()
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(text)) addIssue(issues, 'error', 'invalid_identifier', path, 'must be 1-64 letters, numbers, underscores, or dashes')
  return text
}

function normalizeVersion(value: unknown, path: string, issues: BlueprintValidationIssue[]): string {
  if (typeof value !== 'string') {
    addIssue(issues, 'error', 'invalid_version', path, 'must be a string')
    return ''
  }
  const text = value.trim()
  if (!/^[a-zA-Z0-9_.:-]{1,64}$/.test(text)) addIssue(issues, 'error', 'invalid_version', path, 'must be 1-64 letters, numbers, underscores, dashes, dots, or colons')
  return text
}

function normalizeIdentifierList(input: unknown[], path: string, issues: BlueprintValidationIssue[]): string[] {
  if (!Array.isArray(input)) {
    addIssue(issues, 'error', 'invalid_list', path, 'must be an array')
    return []
  }
  const values = input.map((value, index) => normalizeIdentifier(value, `${path}[${index}]`, issues)).filter(Boolean)
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) addIssue(issues, 'error', 'duplicate_grant', `${path}.${value}`, `duplicate grant/reference must be removed: ${value}`)
    seen.add(value)
  }
  return [...new Set(values)]
}

function validateRawDuplicateList(input: unknown, path: string, issues: BlueprintValidationIssue[]): void {
  if (!Array.isArray(input)) return
  const seen = new Set<string>()
  for (const value of input) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (!normalized) continue
    if (seen.has(normalized)) addIssue(issues, 'error', 'duplicate_grant', `${path}.${normalized}`, `duplicate grant/reference must be removed: ${normalized}`)
    seen.add(normalized)
  }
}

function normalizeMetadata(input: BlueprintMetadata | undefined, issues: BlueprintValidationIssue[]): BlueprintMetadata | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addIssue(issues, 'error', 'invalid_metadata', 'metadata', 'metadata must be an object')
    return undefined
  }
  return input
}

function normalizeRollback(input: BlueprintRollbackMetadata | undefined, issues: BlueprintValidationIssue[]): BlueprintRollbackMetadata | undefined {
  if (input === undefined) return undefined
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    addIssue(issues, 'error', 'invalid_rollback', 'rollback', 'rollback must be an object')
    return undefined
  }
  return {
    replaces: input.replaces ? normalizeIdentifierList(input.replaces, 'rollback.replaces', issues) : undefined,
    deprecates: input.deprecates ? normalizeIdentifierList(input.deprecates, 'rollback.deprecates', issues) : undefined,
    rollbackTargets: input.rollbackTargets ? normalizeIdentifierList(input.rollbackTargets, 'rollback.rollbackTargets', issues) : undefined,
    notes: typeof input.notes === 'string' ? input.notes.substring(0, 1000) : undefined,
  }
}

function permissionAllows(permission: Record<string, string>, key: string): boolean {
  return permission[key] === 'allow' || permission[key] === 'ask'
}

function addIssue(issues: BlueprintValidationIssue[], severity: BlueprintSeverity, code: string, path: string, message: string): void {
  issues.push({ severity, code, path, message })
}

function blueprintRevisionInput(input: BlueprintDefinition, profiles: Record<string, AgentProfile>, teams: Record<string, AgentTeamConfig>): unknown {
  const { expected: _expected, ...definition } = input
  return { ...definition, profiles, teams }
}

function stampProfileMetadata(profile: AgentProfile, blueprintVersion: string, appliedAt: string): AgentProfile {
  return {
    ...profile,
    version: profile.version || blueprintVersion,
    updatedAt: profile.updatedAt || appliedAt,
  }
}

function stampTeamMetadata(team: AgentTeamConfig, blueprintVersion: string, appliedAt: string): AgentTeamConfig {
  const stamped = { ...team, version: team.version || blueprintVersion, updatedAt: team.updatedAt || appliedAt }
  return { ...stamped, revision: agentTeamRevision(stamped) }
}

function stampPreviewProfileVersions(profiles: Record<string, AgentProfile>, blueprintVersion: string): Record<string, AgentProfile> {
  return Object.fromEntries(Object.entries(profiles).map(([name, profile]) => [name, { ...profile, version: profile.version || blueprintVersion }]))
}

function stampPreviewTeamVersions(teams: Record<string, AgentTeamConfig>, blueprintVersion: string): Record<string, AgentTeamConfig> {
  return Object.fromEntries(Object.entries(teams).map(([name, team]) => {
    const stamped = { ...team, version: team.version || blueprintVersion }
    return [name, { ...stamped, revision: agentTeamRevision(stamped) }]
  }))
}

function configRevision(target: 'profile' | 'agentTeam', value: unknown): string | undefined {
  if (!value) return undefined
  return target === 'profile' ? agentProfileRevision(value as AgentProfile) : (value as AgentTeamConfig).revision
}

function blueprintRevision(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16)
}

// Deliberately NOT the shared src/stable-stringify.ts helper (see its
// docstring): this copy feeds persisted blueprintRevision hashes and its
// undefined-handling differs (drops undefined object props, null for undefined
// array elements), so swapping implementations would break revision stability.
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: any): any {
  if (Array.isArray(value)) return value.map(sortValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]))
}
