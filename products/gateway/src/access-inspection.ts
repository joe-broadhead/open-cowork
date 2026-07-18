import type { AgentProfile, AgentTeamConfig, GatewayConfig } from './config.js'
import { resolveEnvironmentSpec } from './environments.js'
import { GATEWAY_AGENT_NAMES, GATEWAY_SKILL_NAMES } from './opencode-defaults.js'
import { listOpenCodeAgents, listOpenCodeMcp, listOpenCodeSkills, listOpenCodeTools } from './opencode-assets.js'
import { isGatewayMcpToolName } from './gateway-tools.js'

export type AccessInspectionKind = 'profile' | 'team'
export type AccessInspectionStatus = 'valid' | 'warning' | 'blocked'
export type AccessWarningSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical'

export interface AccessInspectionWarning {
  code: string
  severity: AccessWarningSeverity
  message: string
  subject: string
  path?: string
  action: string
  failClosed?: boolean
  details?: Record<string, unknown>
}

export interface AccessGrantSummary {
  agents: string[]
  skills: string[]
  mcpServers: string[]
  tools: string[]
  capabilities: string[]
  permissions: Array<{ key: string; policy: 'allow' | 'ask' | 'deny' }>
  environments: Array<{ name: string; backend?: string; network?: string; secrets?: string[]; tools?: string[] }>
}

export interface AccessInspection {
  kind: AccessInspectionKind
  name: string
  status: AccessInspectionStatus
  grants: AccessGrantSummary
  warnings: AccessInspectionWarning[]
  requirements: Array<{ stage?: string; capability: string; satisfied: boolean; profile?: string }>
  subjects: Array<{ kind: 'profile'; name: string; agent?: string }>
  generatedAt: string
}

export interface OpenCodeAssetAvailability {
  agents: Set<string>
  skills: Set<string>
  mcpServers: Set<string>
  tools: Set<string>
  source: 'opencode-config' | 'provided' | 'unavailable'
  error?: string
}

export interface AccessInspectionOptions {
  config: GatewayConfig
  availability?: OpenCodeAssetAvailability
  now?: Date
}

const RISKY_ALLOW_KEYS = new Set(['edit', 'bash', 'webfetch', 'websearch'])

export function inspectOpenCodeAvailability(configDir?: string): OpenCodeAssetAvailability {
  try {
    return {
      agents: new Set(Object.keys(listOpenCodeAgents(configDir))),
      skills: new Set(listOpenCodeSkills(configDir).map(skill => skill.name)),
      mcpServers: new Set(Object.keys(listOpenCodeMcp(configDir))),
      tools: new Set(listOpenCodeTools(configDir).map(tool => tool.name)),
      source: 'opencode-config',
    }
  } catch (err: any) {
    return {
      agents: new Set(),
      skills: new Set(),
      mcpServers: new Set(),
      tools: new Set(),
      source: 'unavailable',
      error: err?.message || String(err),
    }
  }
}

export function inspectProfileAccess(name: string, profile: AgentProfile, options: AccessInspectionOptions): AccessInspection {
  const availability = options.availability || inspectOpenCodeAvailability(options.config.opencodeConfigDir)
  const warnings: AccessInspectionWarning[] = []
  const grants = profileGrants(profile, options.config)
  const subject = `profile:${name}`

  if (!profile.skills?.length) warnings.push(warning('LP_PROFILE_NO_SKILLS', 'medium', subject, 'skills', 'Profile has no declared skills, so operators cannot tell which workflow contract it is expected to follow.', 'Declare the smallest skill set needed by this profile.'))
  if (!Object.keys(profile.permission || {}).length) warnings.push(warning('LP_PERMISSION_POLICY_MISSING', 'critical', subject, 'permission', 'Profile has no explicit permission policy and must fail closed until access is declared.', 'Add an explicit OpenCode permission map with allow, ask, or deny for each intended grant.', true))
  if (!permissionAllowsRead(profile.permission || {})) warnings.push(warning('LP_REQUIRED_GRANT_MISSING', 'critical', subject, 'permission.read', 'Profile does not allow or ask for read access, so normal inspection and task execution may fail unpredictably.', 'Set read to allow or ask, or remove this profile from dispatch paths.', true))

  inspectModelReference(name, profile, warnings)
  inspectAssetReferences(name, profile, availability, warnings)
  inspectPermissionPolicy(name, profile, warnings)
  inspectEnvironment(name, profile, options.config, warnings)

  return finalizeInspection({
    kind: 'profile',
    name,
    grants,
    warnings,
    requirements: [],
    subjects: [{ kind: 'profile', name, agent: profile.agent }],
    generatedAt: (options.now || new Date()).toISOString(),
  })
}

export function inspectTeamAccess(name: string, team: AgentTeamConfig, options: AccessInspectionOptions): AccessInspection {
  const availability = options.availability || inspectOpenCodeAvailability(options.config.opencodeConfigDir)
  const warnings: AccessInspectionWarning[] = []
  const subjects: AccessInspection['subjects'] = []
  const requirements: AccessInspection['requirements'] = []
  const grants = emptyGrantSummary()
  const profiles = options.config.profiles || {}

  for (const profileName of unique(Object.values(team.roles || {}))) {
    const profile = profiles[profileName]
    if (!profile) continue
    const inspection = inspectProfileAccess(profileName, profile, { ...options, availability })
    mergeGrants(grants, inspection.grants)
    subjects.push({ kind: 'profile', name: profileName, agent: profile.agent })
    for (const row of inspection.warnings) warnings.push({ ...row, subject: `team:${name}/${row.subject}` })
  }

  for (const [stage, profileName] of Object.entries(team.roles || {})) {
    if (!profiles[profileName]) {
      warnings.push(warning('LP_TEAM_PROFILE_UNKNOWN', 'critical', `team:${name}`, `roles.${stage}`, `Team role ${stage} references missing profile ${profileName}; dispatch must fail closed.`, 'Create the profile first or change the role to an existing bounded profile.', true))
    }
  }

  for (const stage of teamValidationStages(team)) {
    const profileName = team.roles[stage] || team.roles['default']
    const profile = profileName ? profiles[profileName] : undefined
    const required = teamStageCapabilityRequirements(team, stage)
    for (const capability of required) {
      const satisfied = Boolean(profile && profileHasCapability(profile, capability))
      requirements.push({ stage, capability, satisfied, profile: profileName })
      if (!satisfied) {
        warnings.push(warning('LP_REQUIRED_GRANT_MISSING', 'critical', `team:${name}`, `capabilityRequirements.${stage}.${capability}`, `Stage ${stage} requires ${capability}, but profile ${profileName || '(none)'} does not provide it; dispatch must fail closed.`, 'Add the capability to the resolved profile, choose a profile that already has it, or remove the requirement.', true))
      }
    }
  }

  return finalizeInspection({
    kind: 'team',
    name,
    grants,
    warnings,
    requirements,
    subjects,
    generatedAt: (options.now || new Date()).toISOString(),
  })
}

export function failClosedWarnings(inspection: AccessInspection): AccessInspectionWarning[] {
  return inspection.warnings.filter(row => row.failClosed || row.severity === 'critical')
}

export function formatAccessValidationError(inspection: AccessInspection): string {
  const blockers = failClosedWarnings(inspection)
  const first = blockers[0]
  if (!first) return `${inspection.kind} access inspection passed`
  return `${first.code}: ${first.message} Action: ${first.action}`
}

function inspectModelReference(name: string, profile: AgentProfile, warnings: AccessInspectionWarning[]): void {
  const subject = `profile:${name}`
  const providerID = profile.model?.providerID
  const modelID = profile.model?.modelID
  if (!isValidProviderId(providerID)) {
    warnings.push(warning('LP_MODEL_INVALID', 'critical', subject, 'model.providerID', `Model provider id ${providerID || '(missing)'} is malformed; dispatch must fail closed before a provider call.`, 'Use the exact provider id reported by OpenCode for this profile, without whitespace or control characters.', true))
  }
  if (!isValidModelId(modelID)) {
    warnings.push(warning('LP_MODEL_INVALID', 'critical', subject, 'model.modelID', `Model id ${modelID || '(missing)'} is malformed; dispatch must fail closed before a provider call.`, 'Use the exact model id reported by OpenCode for this provider, without whitespace, traversal, or control characters.', true))
  }
}

function isValidProviderId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)
}

function isValidModelId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) return false
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return false
  if (value.includes('..') || value.startsWith('/') || value.endsWith('/')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(value)
}

function inspectAssetReferences(name: string, profile: AgentProfile, availability: OpenCodeAssetAvailability, warnings: AccessInspectionWarning[]): void {
  const subject = `profile:${name}`
  if (!assetAvailable('agent', profile.agent, availability)) warnings.push(warning('LP_AGENT_UNKNOWN', 'critical', subject, 'agent', `OpenCode agent ${profile.agent} is not installed or Gateway-shipped; validation must fail closed.`, 'Install the agent in the selected OpenCode profile or switch this profile to a known Gateway agent.', true))
  for (const skill of profile.skills || []) {
    if (!assetAvailable('skill', skill, availability)) warnings.push(warning('LP_SKILL_UNKNOWN', 'critical', subject, `skills.${skill}`, `OpenCode skill ${skill} is not installed or Gateway-shipped; validation must fail closed.`, 'Install the skill in the selected OpenCode profile or remove it from this profile.', true))
  }
  for (const server of profile.mcpServers || []) {
    if (!assetAvailable('mcp', server, availability)) warnings.push(warning('LP_MCP_UNKNOWN', 'critical', subject, `mcpServers.${server}`, `MCP server ${server} is not configured; validation must fail closed.`, 'Configure the MCP server in OpenCode or remove the reference from this profile.', true))
  }
  for (const tool of profile.tools || []) {
    if (!assetAvailable('tool', tool, availability)) warnings.push(warning('LP_TOOL_UNKNOWN', 'critical', subject, `tools.${tool}`, `Tool ${tool} is not installed or Gateway-owned; validation must fail closed.`, 'Install the tool, expose it through the Gateway MCP, or remove the reference.', true))
    if (tool.startsWith('gateway_') && !(profile.mcpServers || []).includes('gateway')) warnings.push(warning('LP_GATEWAY_MCP_MISSING', 'critical', subject, `tools.${tool}`, `Gateway tool ${tool} is declared, but mcpServers does not include gateway.`, 'Add gateway to mcpServers or remove the Gateway tool reference.', true))
  }
}

function inspectPermissionPolicy(name: string, profile: AgentProfile, warnings: AccessInspectionWarning[]): void {
  const permission = profile.permission || {}
  const subject = `profile:${name}`
  const allowed = Object.entries(permission).filter(([, policy]) => policy === 'allow').map(([key]) => key || '(default)')
  for (const key of allowed) {
    const normalized = key.toLowerCase()
    if (normalized === '*' || normalized === '(default)') {
      warnings.push(warning('LP_PERMISSION_BROAD_ALLOW', 'critical', subject, `permission.${key}`, `Broad default allow grant ${key} can expose tools outside this profile's intended role.`, 'Replace broad allow with explicit allow/ask/deny entries for the required tools only.', true))
    } else if (containsSecretGrant(normalized)) {
      warnings.push(warning('LP_PERMISSION_SECRET_ALLOW', 'critical', subject, `permission.${key}`, `Secret-like permission ${key}=allow can expose credentials without an operator decision.`, 'Change this grant to ask or deny and use an audited human gate for credential access.', true))
    } else if (RISKY_ALLOW_KEYS.has(normalized)) {
      warnings.push(warning('LP_PERMISSION_RISKY_ALLOW', 'high', subject, `permission.${key}`, `Permission ${key}=allow permits high-impact actions for this profile.`, 'Use ask or deny unless this exact role requires the grant, and document the reason in the profile description.'))
    }
  }

  if (profile.role === 'planning' && (permission['edit'] === 'allow' || permission['bash'] === 'allow')) {
    warnings.push(warning('LP_ROLE_GRANT_TOO_BROAD', 'high', subject, 'permission', 'Planning profile allows edit or bash, which is broader than a planning role normally needs.', 'Move write or shell work to an execution profile, or downgrade edit/bash to ask.'))
  }
  if (permission['edit'] === 'allow' && permission['bash'] === 'allow' && (permission['webfetch'] === 'allow' || permission['websearch'] === 'allow')) {
    warnings.push(warning('LP_RISKY_COMBINATION', 'high', subject, 'permission', 'Profile combines write access, shell access, and web access, increasing supply-chain and exfiltration risk.', 'Split web research from code mutation, or require ask for web or shell access.'))
  }
  for (const conflict of conflictingGrants(permission)) {
    warnings.push(warning('LP_PERMISSION_CONFLICT', 'medium', subject, `permission.${conflict.key}`, conflict.message, 'Prefer the narrowest explicit grant and remove contradictory broad grants.'))
  }
}

function inspectEnvironment(name: string, profile: AgentProfile, config: GatewayConfig, warnings: AccessInspectionWarning[]): void {
  if (!profile.environment) return
  const subject = `profile:${name}`
  const path = 'environment'
  const resolution = resolveEnvironmentSpec({ profileEnvironment: profile.environment, config: config.environments, stage: 'access-inspection' })
  if (!resolution.ok) {
    warnings.push(warning('LP_ENVIRONMENT_UNKNOWN', 'critical', subject, path, `Profile environment cannot be resolved: ${resolution.reason}`, 'Reference a configured environment or fix the inline environment selector.', true))
    return
  }
  const spec = resolution.spec
  if (spec.backend === 'remote-crabbox') warnings.push(warning('LP_ENVIRONMENT_REMOTE', 'medium', subject, path, `Environment ${spec.name} uses remote execution.`, 'Confirm the profile really needs remote execution and keep approval policy enabled.'))
  if (spec.network.mode === 'unrestricted') warnings.push(warning('LP_ENVIRONMENT_NETWORK_UNRESTRICTED', 'high', subject, path, `Environment ${spec.name} has unrestricted network access.`, 'Use restricted or disabled network mode unless this role requires arbitrary outbound access.'))
  if (spec.secrets.allow.length) warnings.push(warning('LP_ENVIRONMENT_SECRETS', 'high', subject, path, `Environment ${spec.name} allows ${spec.secrets.allow.length} secret name(s).`, 'Limit secrets to the smallest named set and prefer ask-gated credential use.'))
  if (spec.container?.privileged) warnings.push(warning('LP_ENVIRONMENT_PRIVILEGED_CONTAINER', 'critical', subject, path, `Environment ${spec.name} uses a privileged container.`, 'Disable privileged mode or require an audited approval before this profile is used.', true))
}

function profileGrants(profile: AgentProfile, config: GatewayConfig): AccessGrantSummary {
  const grants = emptyGrantSummary()
  grants.agents.push(profile.agent)
  grants.skills.push(...(profile.skills || []))
  grants.mcpServers.push(...(profile.mcpServers || []))
  grants.tools.push(...(profile.tools || []))
  grants.capabilities.push(...(profile.capabilities || []))
  grants.permissions.push(...Object.entries(profile.permission || {}).map(([key, policy]) => ({ key: key || '(default)', policy: policy as 'allow' | 'ask' | 'deny' })))
  if (profile.environment) {
    const resolution = resolveEnvironmentSpec({ profileEnvironment: profile.environment, config: config.environments, stage: 'access-inspection' })
    if (resolution.ok) {
      grants.environments.push({
        name: resolution.spec.name,
        backend: resolution.spec.backend,
        network: resolution.spec.network.mode,
        secrets: resolution.spec.secrets.allow,
        tools: resolution.spec.tools,
      })
    }
  }
  sortGrantSummary(grants)
  return grants
}

function assetAvailable(kind: 'agent' | 'skill' | 'mcp' | 'tool', name: string | undefined, availability: OpenCodeAssetAvailability): boolean {
  if (!name) return false
  if (kind === 'agent') return availability.agents.has(name) || (GATEWAY_AGENT_NAMES as readonly string[]).includes(name)
  if (kind === 'skill') return availability.skills.has(name) || (GATEWAY_SKILL_NAMES as readonly string[]).includes(name)
  if (kind === 'mcp') return availability.mcpServers.has(name) || name === 'gateway'
  return availability.tools.has(name) || isGatewayMcpToolName(name)
}

function permissionAllowsRead(permission: Record<string, string>): boolean {
  return permission['read'] === 'allow' || permission['read'] === 'ask'
}

function containsSecretGrant(key: string): boolean {
  return key.includes('credential') || key.includes('secret') || key.includes('token') || key.includes('password') || key.includes('cookie') || key.includes('auth')
}

function conflictingGrants(permission: Record<string, string>): Array<{ key: string; message: string }> {
  const conflicts: Array<{ key: string; message: string }> = []
  if (permission['*'] === 'allow') {
    for (const [key, policy] of Object.entries(permission)) {
      if (key !== '*' && (policy === 'ask' || policy === 'deny')) conflicts.push({ key, message: `Wildcard allow conflicts with ${key}=${policy}; operators cannot tell whether the narrow grant is effective.` })
    }
  }
  for (const [key, policy] of Object.entries(permission)) {
    if (!key.endsWith('*') || policy !== 'allow') continue
    const prefix = key.slice(0, -1)
    for (const [otherKey, otherPolicy] of Object.entries(permission)) {
      if (otherKey !== key && otherKey.startsWith(prefix) && (otherPolicy === 'ask' || otherPolicy === 'deny')) conflicts.push({ key: otherKey, message: `Prefix allow ${key}=allow conflicts with ${otherKey}=${otherPolicy}.` })
    }
  }
  return conflicts
}

function profileHasCapability(profile: AgentProfile, capability: string): boolean {
  if (profile.agent === capability) return true
  if ((profile.skills || []).includes(capability)) return true
  if ((profile.tools || []).includes(capability)) return true
  if ((profile.mcpServers || []).includes(capability)) return true
  if ((profile.capabilities || []).includes(capability)) return true
  const permission = profile.permission || {}
  return permission[capability] === 'allow' || permission[`${capability}_`] === 'allow' || permission[`${capability}_*`] === 'allow'
}

function teamValidationStages(team: AgentTeamConfig): string[] {
  const stages = new Set([...Object.keys(team.roles || {}), ...Object.keys(team.capabilityRequirements || {})])
  stages.delete('default')
  if (!stages.size) stages.add('default')
  return [...stages].sort(stageSort)
}

function teamStageCapabilityRequirements(team: AgentTeamConfig, stage: string): string[] {
  return unique([...(team.capabilityRequirements['default'] || []), ...(stage === 'default' ? [] : team.capabilityRequirements[stage] || [])])
}

function emptyGrantSummary(): AccessGrantSummary {
  return { agents: [], skills: [], mcpServers: [], tools: [], capabilities: [], permissions: [], environments: [] }
}

function mergeGrants(target: AccessGrantSummary, source: AccessGrantSummary): void {
  target.agents.push(...source.agents)
  target.skills.push(...source.skills)
  target.mcpServers.push(...source.mcpServers)
  target.tools.push(...source.tools)
  target.capabilities.push(...source.capabilities)
  target.permissions.push(...source.permissions)
  target.environments.push(...source.environments)
  sortGrantSummary(target)
}

function sortGrantSummary(grants: AccessGrantSummary): void {
  grants.agents = unique(grants.agents).sort()
  grants.skills = unique(grants.skills).sort()
  grants.mcpServers = unique(grants.mcpServers).sort()
  grants.tools = unique(grants.tools).sort()
  grants.capabilities = unique(grants.capabilities).sort()
  grants.permissions = grants.permissions
    .filter((row, index, rows) => rows.findIndex(other => other.key === row.key && other.policy === row.policy) === index)
    .sort((a, b) => a.key.localeCompare(b.key) || a.policy.localeCompare(b.policy))
  grants.environments = grants.environments
    .filter((row, index, rows) => rows.findIndex(other => other.name === row.name) === index)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function finalizeInspection(input: Omit<AccessInspection, 'status'>): AccessInspection {
  const status = input.warnings.some(row => row.failClosed || row.severity === 'critical')
    ? 'blocked'
    : input.warnings.length
      ? 'warning'
      : 'valid'
  return { ...input, status }
}

function warning(code: string, severity: AccessWarningSeverity, subject: string, path: string, message: string, action: string, failClosed = false, details?: Record<string, unknown>): AccessInspectionWarning {
  return { code, severity, subject, path, message, action, failClosed, details }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function stageSort(a: string, b: string): number {
  const order = ['default', 'plan', 'implement', 'review', 'verify', 'audit']
  const ai = order.indexOf(a)
  const bi = order.indexOf(b)
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b)
  return a.localeCompare(b)
}
