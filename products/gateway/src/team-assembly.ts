import * as fs from 'node:fs'
import { stableStringify } from './stable-stringify.js'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import {
  agentProfileRevision,
  getConfig,
  type AgentProfile,
  type AgentPromotionState,
  type AgentTeamConfig,
  type GatewayConfig,
} from './config.js'
import { previewBlueprint, type BlueprintDefinition, type BlueprintPreview, type BlueprintValidationIssue } from './blueprints.js'
import { listBlueprintCatalogDirs } from './agent-catalog.js'
import {
  failClosedWarnings,
  inspectOpenCodeAvailability,
  inspectTeamAccess,
  type AccessGrantSummary,
  type OpenCodeAssetAvailability,
} from './access-inspection.js'
import { getPromotionState } from './work-store/promotions.js'

export interface TeamAssemblyRoleRequest {
  role: string
  purpose?: string
  requiredCapabilities?: string[]
  profilePreference?: string
}

export interface TeamAssemblyGrantRequest {
  role: string
  skills?: string[]
  mcpServers?: string[]
  tools?: string[]
  permission?: Record<string, 'allow' | 'ask' | 'deny'>
  reason?: string
}

export interface TeamAssemblyRequest {
  version?: number
  idempotencyKey?: string
  objective?: string
  packageRef?: {
    id?: string
    version?: string
    fingerprint?: string
    trustTier?: string
  }
  blueprint?: string | { name?: string; version?: string }
  blueprintName?: string
  blueprintVersion?: string
  teamName?: string
  team?: {
    preferredTeam?: string
    requiredPromotionState?: AgentPromotionState[]
    roles?: TeamAssemblyRoleRequest[]
  }
  roles?: TeamAssemblyRoleRequest[]
  grants?: TeamAssemblyGrantRequest[]
  requiredPromotionState?: AgentPromotionState[]
  budget?: Record<string, unknown>
  gates?: Array<Record<string, unknown>>
  evidenceRequirements?: Array<Record<string, unknown>>
}

export interface TeamAssemblyRejection {
  code: string
  path: string
  message: string
  action: string
}

export interface TeamAssemblyMember {
  memberId: string
  role: string
  purpose?: string
  stage: string
  profile: string
  agent: string
  model: string
  profileVersion: string
  profileRevision: string
  promotionState: AgentPromotionState
  grants: AccessGrantSummary
  grantHash: string
  budget: {
    requested?: Record<string, unknown>
    profile?: Record<string, unknown>
    gatesPlaceholder: string
  }
  gates: Array<Record<string, unknown>>
  rejectionReasons: TeamAssemblyRejection[]
}

export interface TeamAssemblyReceipt {
  receiptKind: 'team_assembly'
  version: 1
  id: string
  teamRequestId: string
  idempotencyKey: string
  status: 'accepted' | 'rejected'
  objective?: string
  createdAt: string
  selectedBlueprint?: {
    name: string
    version: string
    revision: string
    source: string
  }
  selectedPackage?: {
    id: string
    version: string
    fingerprint?: string
    trustTier?: string
  }
  selectedTeam: {
    id: string
    name: string
    version: string
    revision: string
    promotionState: AgentPromotionState
    source: string
  }
  members: TeamAssemblyMember[]
  blockedRoles: TeamAssemblyMember[]
  grants: AccessGrantSummary
  budget: {
    request?: Record<string, unknown>
    gatesPlaceholder: string
    enforcementPlaceholder: string
  }
  gates: Array<Record<string, unknown>>
  evidenceRequirements: Array<Record<string, unknown>>
  rejectionReasons: TeamAssemblyRejection[]
  audit: {
    resolverVersion: 'team-assembly-v1'
    selectionInputs: string[]
    createdAt: string
  }
}

export interface TeamAssemblyResult {
  ok: boolean
  receipt: TeamAssemblyReceipt
}

export interface TeamAssemblyOptions {
  config?: GatewayConfig
  blueprintDirs?: string[]
  availability?: OpenCodeAssetAvailability
  now?: Date
  workStateFilePath?: string
}

interface AssemblySource {
  type: 'config' | 'blueprint_file'
  source: string
  blueprint?: BlueprintPreview['blueprint']
  profiles: Record<string, AgentProfile>
  teams: Record<string, AgentTeamConfig>
}

type NormalizedTeamAssemblyRoleRequest = TeamAssemblyRoleRequest & {
  invalidRole?: {
    path: string
    value: string
  }
}

const PROMOTED_ONLY: AgentPromotionState[] = ['promoted']

export function assembleBoundedTeam(input: TeamAssemblyRequest, options: TeamAssemblyOptions = {}): TeamAssemblyResult {
  const config = options.config || getConfig()
  const createdAt = (options.now || new Date()).toISOString()
  const request = normalizeAssemblyRequest(input)
  const source = resolveAssemblySource(request, config, options)
  const rejections: TeamAssemblyRejection[] = []
  const selectionInputs: string[] = []
  const teamName = request.teamName || request.team?.preferredTeam || ''
  const team = teamName ? source.teams[teamName] : undefined
  const teamSource = source.type === 'blueprint_file' ? `${source.source}#teams.${teamName}` : `config.agentTeams.${teamName}`
  const teamPromotionState = team ? promotionStateForTeam(teamName, team, source.type, options.workStateFilePath) : 'draft'
  const teamVersion = team ? team.version || `rev:${team.revision}` : 'missing'
  const packageSelection = normalizePackageRef(request.packageRef)
  const teamId = stableId('team', [request.idempotencyKey, packageSelection || 'no-package', source.blueprint?.name || 'config', source.blueprint?.version || 'current', teamName || 'missing'])
  const teamRequestId = stableId('team_req', [request.idempotencyKey])
  const receiptId = stableId('team_assembly_receipt', [request.idempotencyKey, packageSelection || 'no-package', source.blueprint?.revision || 'config', teamName || 'missing'])

  selectionInputs.push(source.blueprint ? `blueprint:${source.blueprint.name}@${source.blueprint.version}` : 'source:config')
  if (teamName) selectionInputs.push(`team:${teamName}`)
  if (packageSelection) selectionInputs.push(`package:${packageSelection.id}@${packageSelection.version}${packageSelection.fingerprint ? `#${packageSelection.fingerprint}` : ''}`)

  if (!request.idempotencyKey) rejections.push(rejection('missing_idempotency_key', 'idempotencyKey', 'Team assembly requires idempotencyKey.', 'Provide a caller-stable idempotencyKey and retry.'))
  if (!teamName) rejections.push(rejection('missing_team', 'teamName', 'Team assembly requires teamName or team.preferredTeam.', 'Name the blueprint team definition to assemble.'))
  if (!team) rejections.push(rejection('team_not_found', 'teamName', `Team definition not found: ${teamName || '(missing)'}.`, 'Apply or reference a blueprint/team that defines this team.'))
  if (source.type === 'blueprint_file' && !source.blueprint) rejections.push(rejection('blueprint_invalid', 'blueprint', 'Blueprint could not be resolved.', 'Use a valid persisted blueprint file or assemble from config.'))
  if (request.packageRef && !packageSelection) rejections.push(rejection('package_ref_invalid', 'packageRef', 'Team assembly packageRef requires bounded id and version fields.', 'Use the governed package preview output package ID and version.'))

  if (team && !request.requiredPromotionState.includes(teamPromotionState)) {
    rejections.push(rejection('team_unpromoted', 'team.promotionState', `Team ${teamName} is ${teamPromotionState}; required state: ${request.requiredPromotionState.join(', ')}.`, 'Promote the team or explicitly request an allowed rollout state.'))
  }

  if (source.type === 'blueprint_file') {
    const preview = loadBlueprintPreview(request, config, options)
    if (preview && !preview.ok) {
      for (const issue of preview.validation.errors) rejections.push(blueprintIssueRejection(issue))
    }
  }

  const availability = options.availability || inspectOpenCodeAvailability(config.opencodeConfigDir)
  if (team) {
    const inspectionConfig = { ...config, profiles: source.profiles, agentTeams: { ...config.agentTeams, [teamName]: team } }
    const inspection = inspectTeamAccess(teamName, team, { config: inspectionConfig, availability })
    for (const warning of failClosedWarnings(inspection)) {
      rejections.push(rejection('unsafe_team_access', warning.path || 'inspection', warning.message, warning.action))
    }
  }

  const roles = requestedRoles(request, team)
  const grantsByRole = new Map(request.grants.map(grant => [grant.role, grant]))
  const members = roles.map(roleRequest => {
    const stage = roleRequest.role
    const profileName = roleRequest.invalidRole ? '' : roleRequest.profilePreference || team?.roles[stage] || team?.roles['default'] || ''
    selectionInputs.push(`role:${stage}`)
    if (profileName) selectionInputs.push(`profile:${profileName}`)
    const profile = profileName ? source.profiles[profileName] : undefined
    const profileRevision = profile ? agentProfileRevision(profile) : 'missing'
    const profilePromotionState = profile ? promotionStateForProfile(profileName, profile, source.type, options.workStateFilePath) : 'draft'
    const memberRejections: TeamAssemblyRejection[] = []

    if (roleRequest.invalidRole) {
      memberRejections.push(rejection('invalid_role', roleRequest.invalidRole.path, `Role name ${roleRequest.invalidRole.value || '(missing)'} is invalid.`, 'Use a role name containing only letters, numbers, underscores, or hyphens, up to 64 characters.'))
    }
    if (!profile) memberRejections.push(rejection('profile_not_found', `roles.${stage}.profile`, `Role ${stage} resolves missing profile ${profileName || '(missing)'}.`, 'Create, apply, or select a profile that exists in the chosen blueprint/team source.'))
    if (profile && !request.requiredPromotionState.includes(profilePromotionState)) {
      memberRejections.push(rejection('profile_unpromoted', `roles.${stage}.promotionState`, `Profile ${profileName} is ${profilePromotionState}; required state: ${request.requiredPromotionState.join(', ')}.`, 'Promote the profile or explicitly request an allowed rollout state.'))
    }

    for (const capability of roleRequest.requiredCapabilities || []) {
      if (!profile || !profileHasCapability(profile, capability)) {
        memberRejections.push(rejection('capability_missing', `roles.${stage}.requiredCapabilities.${capability}`, `Role ${stage} requires ${capability}, but profile ${profileName || '(missing)'} does not provide it.`, 'Choose a profile with this capability or remove the role capability requirement.'))
      }
    }

    if (team) {
      for (const capability of stageRequirements(team, stage)) {
        if (!profile || !profileHasCapability(profile, capability)) {
          memberRejections.push(rejection('team_capability_missing', `team.capabilityRequirements.${stage}.${capability}`, `Team role ${stage} requires ${capability}, but profile ${profileName || '(missing)'} does not provide it.`, 'Fix the team capability requirement or select a matching profile.'))
        }
      }
    }

    const requestedGrant = grantsByRole.get(stage)
    if (requestedGrant && !requestedGrant.reason?.trim()) {
      memberRejections.push(rejection('grant_reason_missing', `grants.${stage}.reason`, `Grant request for role ${stage} must include a reason.`, 'Add a role-specific reason for the requested grant.'))
    }
    const grants = profile ? effectiveGrants(profile, requestedGrant, memberRejections, `grants.${stage}`) : emptyGrantSummary()
    const memberId = `${teamId}:member:${safeToken(stage)}:${shortHash(profileName || 'missing')}`
    return {
      memberId,
      role: stage,
      purpose: roleRequest.purpose,
      stage,
      profile: profileName || 'missing',
      agent: profile?.agent || 'missing',
      model: profile ? `${profile.model.providerID}/${profile.model.modelID}${profile.model.variant ? `:${profile.model.variant}` : ''}` : 'missing',
      profileVersion: profile ? profile.version || `rev:${profileRevision}` : 'missing',
      profileRevision,
      promotionState: profilePromotionState,
      grants,
      grantHash: stableId('grant', [stage, grants]),
      budget: {
        requested: request.budget,
        profile: profile?.budget as Record<string, unknown> | undefined,
        gatesPlaceholder: 'budget gates are recorded for dispatch enforcement by later runtime paths',
      },
      gates: request.gates,
      rejectionReasons: memberRejections,
    }
  }).sort((a, b) => a.role.localeCompare(b.role) || a.profile.localeCompare(b.profile))

  for (const member of members) rejections.push(...member.rejectionReasons)
  const grants = members.reduce((summary, member) => mergeGrantSummaries(summary, member.grants), emptyGrantSummary())
  const receipt: TeamAssemblyReceipt = {
    receiptKind: 'team_assembly',
    version: 1,
    id: receiptId,
    teamRequestId,
    idempotencyKey: request.idempotencyKey || '',
    status: rejections.length ? 'rejected' : 'accepted',
    objective: request.objective,
    createdAt,
    selectedBlueprint: source.blueprint ? {
      name: source.blueprint.name,
      version: source.blueprint.version,
      revision: source.blueprint.revision,
      source: source.source,
    } : undefined,
    selectedPackage: packageSelection,
    selectedTeam: {
      id: teamId,
      name: teamName || 'missing',
      version: teamVersion,
      revision: team?.revision || 'missing',
      promotionState: teamPromotionState,
      source: team ? teamSource : source.source,
    },
    members,
    blockedRoles: members.filter(member => member.rejectionReasons.length),
    grants,
    budget: {
      request: request.budget,
      gatesPlaceholder: 'assembly records requested gates; dispatch enforcement is intentionally not started by this resolver',
      enforcementPlaceholder: 'token/cost/runtime budget state will attach to future team run plans',
    },
    gates: request.gates,
    evidenceRequirements: request.evidenceRequirements,
    rejectionReasons: uniqueRejections(rejections),
    audit: {
      resolverVersion: 'team-assembly-v1',
      selectionInputs: [...new Set(selectionInputs)].sort(),
      createdAt,
    },
  }
  return { ok: receipt.status === 'accepted', receipt }
}

function normalizeAssemblyRequest(input: TeamAssemblyRequest): Required<Pick<TeamAssemblyRequest, 'grants' | 'gates' | 'evidenceRequirements'>> & TeamAssemblyRequest & { requiredPromotionState: AgentPromotionState[] } {
  const team = input.team && typeof input.team === 'object' ? input.team : undefined
  const requiredPromotionState = normalizePromotionStates(input.requiredPromotionState || team?.requiredPromotionState || PROMOTED_ONLY)
  return {
    ...input,
    version: input.version || 1,
    idempotencyKey: typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '',
    blueprintName: blueprintName(input),
    blueprintVersion: blueprintVersion(input),
    teamName: typeof input.teamName === 'string' ? input.teamName.trim() : typeof team?.preferredTeam === 'string' ? team.preferredTeam.trim() : '',
    roles: Array.isArray(input.roles) ? input.roles : undefined,
    team,
    grants: Array.isArray(input.grants) ? input.grants : [],
    requiredPromotionState,
    gates: Array.isArray(input.gates) ? input.gates : [],
    evidenceRequirements: Array.isArray(input.evidenceRequirements) ? input.evidenceRequirements : [],
  }
}

function resolveAssemblySource(request: ReturnType<typeof normalizeAssemblyRequest>, config: GatewayConfig, options: TeamAssemblyOptions): AssemblySource {
  if (!request.blueprintName) {
    return { type: 'config', source: 'config', profiles: config.profiles, teams: config.agentTeams }
  }
  const preview = loadBlueprintPreview(request, config, options)
  if (!preview || !preview.ok) {
    return { type: 'blueprint_file', source: `blueprint:${request.blueprintName}@${request.blueprintVersion || 'any'}`, profiles: {}, teams: {} }
  }
  return {
    type: 'blueprint_file',
    source: findBlueprintFile(request, config, options)?.file || `blueprint:${preview.blueprint.name}@${preview.blueprint.version}`,
    blueprint: preview.blueprint,
    profiles: { ...config.profiles, ...preview.normalized.profiles },
    teams: { ...config.agentTeams, ...preview.normalized.teams },
  }
}

function loadBlueprintPreview(request: ReturnType<typeof normalizeAssemblyRequest>, config: GatewayConfig, options: TeamAssemblyOptions): BlueprintPreview | undefined {
  const match = findBlueprintFile(request, config, options)
  if (!match) return undefined
  return previewBlueprint(match.blueprint, config)
}

function findBlueprintFile(request: ReturnType<typeof normalizeAssemblyRequest>, config: GatewayConfig, options: TeamAssemblyOptions): { file: string; blueprint: BlueprintDefinition } | undefined {
  const dirs = options.blueprintDirs?.length ? options.blueprintDirs : listBlueprintCatalogDirs(config)
  for (const dir of [...new Set(dirs)].sort()) {
    if (!fs.existsSync(dir)) continue
    for (const file of fs.readdirSync(dir).filter(name => name.endsWith('.json')).map(name => path.join(dir, name)).sort()) {
      try {
        const blueprint = JSON.parse(fs.readFileSync(file, 'utf-8')) as BlueprintDefinition
        if (blueprint.name !== request.blueprintName) continue
        if (request.blueprintVersion && blueprint.version !== request.blueprintVersion) continue
        return { file, blueprint }
      } catch {
        continue
      }
    }
  }
  return undefined
}

function requestedRoles(request: ReturnType<typeof normalizeAssemblyRequest>, team: AgentTeamConfig | undefined): NormalizedTeamAssemblyRoleRequest[] {
  const roles = request.roles || request.team?.roles
  if (Array.isArray(roles) && roles.length) {
    const pathPrefix = request.roles ? 'roles' : 'team.roles'
    return roles.map((role, index) => normalizeRoleRequest(role, `${pathPrefix}.${index}.role`, index))
  }
  return assemblyRoleStages(team).map(role => ({ role }))
}

function assemblyRoleStages(team: AgentTeamConfig | undefined): string[] {
  const stages = new Set([...Object.keys(team?.roles || {}), ...Object.keys(team?.capabilityRequirements || {})])
  stages.delete('default')
  if (!stages.size && team?.roles['default']) stages.add('default')
  return [...stages].sort(stageSort)
}

function normalizeRoleRequest(input: TeamAssemblyRoleRequest, rolePath: string, index: number): NormalizedTeamAssemblyRoleRequest {
  const role = parseRole(input.role)
  return {
    role: role || `invalid-${index + 1}`,
    purpose: optionalBoundedText(input.purpose, 500),
    requiredCapabilities: Array.isArray(input.requiredCapabilities) ? [...new Set(input.requiredCapabilities.map(safeCapability))].sort() : [],
    profilePreference: input.profilePreference ? safeToken(input.profilePreference) : undefined,
    invalidRole: role ? undefined : { path: rolePath, value: typeof input.role === 'string' ? input.role : String(input.role) },
  }
}

function normalizePackageRef(input: TeamAssemblyRequest['packageRef']): TeamAssemblyReceipt['selectedPackage'] | undefined {
  if (!input) return undefined
  const id = boundedPackageRef(input.id)
  const version = boundedPackageRef(input.version)
  if (!id || !version) return undefined
  const fingerprint = input.fingerprint && /^[a-f0-9]{8,64}$/i.test(input.fingerprint.trim()) ? input.fingerprint.trim().toLowerCase() : undefined
  const trustTier = input.trustTier && /^[a-zA-Z0-9_-]{1,64}$/.test(input.trustTier.trim()) ? input.trustTier.trim() : undefined
  return { id, version, fingerprint, trustTier }
}

function boundedPackageRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,120}$/.test(trimmed)) return undefined
  return trimmed
}

function parseRole(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.trim())) return undefined
  return value.trim()
}

function safeCapability(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, 128) : ''
}

function safeToken(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

function optionalBoundedText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

function blueprintName(input: TeamAssemblyRequest): string | undefined {
  if (typeof input.blueprint === 'string') return input.blueprint.trim()
  if (input.blueprint && typeof input.blueprint === 'object') return input.blueprint.name?.trim()
  return input.blueprintName?.trim()
}

function blueprintVersion(input: TeamAssemblyRequest): string | undefined {
  if (input.blueprint && typeof input.blueprint === 'object') return input.blueprint.version?.trim()
  return input.blueprintVersion?.trim()
}

function normalizePromotionStates(values: unknown): AgentPromotionState[] {
  const allowed: AgentPromotionState[] = ['draft', 'evaluated', 'promoted', 'deprecated', 'blocked']
  if (!Array.isArray(values)) return PROMOTED_ONLY
  const normalized = values.filter((value): value is AgentPromotionState => allowed.includes(value as AgentPromotionState))
  return normalized.length ? [...new Set(normalized)].sort() : PROMOTED_ONLY
}

function promotionStateForProfile(name: string, profile: AgentProfile, sourceType: AssemblySource['type'], filePath?: string): AgentPromotionState {
  if (sourceType === 'config') return getPromotionState('profile', name, filePath).state
  return profile.promotionState || 'draft'
}

function promotionStateForTeam(name: string, team: AgentTeamConfig, sourceType: AssemblySource['type'], filePath?: string): AgentPromotionState {
  if (sourceType === 'config') return getPromotionState('team', name, filePath).state
  return team.promotionState || 'draft'
}

function stageRequirements(team: AgentTeamConfig, stage: string): string[] {
  return [...new Set([...(team.capabilityRequirements[stage] || []), ...(team.capabilityRequirements['default'] || [])])].sort()
}

function profileHasCapability(profile: AgentProfile, capability: string): boolean {
  const values = new Set([
    profile.agent,
    ...(profile.skills || []),
    ...(profile.mcpServers || []),
    ...(profile.tools || []),
    ...(profile.capabilities || []),
    ...Object.keys(profile.permission || {}),
  ])
  return values.has(capability)
}

function effectiveGrants(profile: AgentProfile, requested: TeamAssemblyGrantRequest | undefined, rejections: TeamAssemblyRejection[], pathPrefix: string): AccessGrantSummary {
  const profileGrants = profileGrantSummary(profile)
  if (!requested) return profileGrants
  const grants = emptyGrantSummary()
  grants.agents = [profile.agent]
  grants.skills = grantSubset('skills', requested.skills, profileGrants.skills, rejections, pathPrefix)
  grants.mcpServers = grantSubset('mcpServers', requested.mcpServers, profileGrants.mcpServers, rejections, pathPrefix)
  grants.tools = grantSubset('tools', requested.tools, profileGrants.tools, rejections, pathPrefix)
  grants.capabilities = [...profileGrants.capabilities]
  const permission = requested.permission || {}
  for (const [key, policy] of Object.entries(permission).sort(([a], [b]) => a.localeCompare(b))) {
    const profilePolicy = profile.permission[key]
    if (!profilePolicy) {
      rejections.push(rejection('grant_not_declared', `${pathPrefix}.permission.${key}`, `Requested permission ${key} is not declared by the selected profile.`, 'Remove the requested permission or add it to a promoted profile contract.'))
      continue
    }
    if (policy === 'allow' && profilePolicy !== 'allow') {
      rejections.push(rejection('grant_escalates_profile', `${pathPrefix}.permission.${key}`, `Requested permission ${key}=allow exceeds profile policy ${profilePolicy}.`, 'Request the same or narrower permission than the selected profile declares.'))
      continue
    }
    if (policy === 'ask' && profilePolicy === 'deny') {
      rejections.push(rejection('grant_escalates_profile', `${pathPrefix}.permission.${key}`, `Requested permission ${key}=ask exceeds profile policy deny.`, 'Request deny or choose a profile that allows an approval-gated permission.'))
      continue
    }
    grants.permissions.push({ key, policy })
  }
  if (!Object.keys(permission).length) grants.permissions = profileGrants.permissions
  grants.environments = profileGrants.environments
  return sortGrantSummary(grants)
}

function grantSubset(kind: 'skills' | 'mcpServers' | 'tools', requested: string[] | undefined, allowed: string[], rejections: TeamAssemblyRejection[], pathPrefix: string): string[] {
  if (!requested) return [...allowed]
  const allowedSet = new Set(allowed)
  const result: string[] = []
  for (const value of [...new Set(requested)].sort()) {
    if (value === '*') {
      rejections.push(rejection('wildcard_grant_denied', `${pathPrefix}.${kind}`, `Wildcard ${kind} grants are not allowed in team assembly.`, 'Request exact role-scoped grants only.'))
      continue
    }
    if (!allowedSet.has(value)) {
      rejections.push(rejection('grant_not_declared', `${pathPrefix}.${kind}.${value}`, `Requested ${kind} grant ${value} is not declared by the selected profile.`, 'Remove the grant or choose a profile that already declares it.'))
      continue
    }
    result.push(value)
  }
  return result
}

function profileGrantSummary(profile: AgentProfile): AccessGrantSummary {
  return sortGrantSummary({
    agents: [profile.agent],
    skills: [...(profile.skills || [])],
    mcpServers: [...(profile.mcpServers || [])],
    tools: [...(profile.tools || [])],
    capabilities: [...(profile.capabilities || [])],
    permissions: Object.entries(profile.permission || {}).map(([key, policy]) => ({ key: key || '(default)', policy: policy as 'allow' | 'ask' | 'deny' })),
    environments: [],
  })
}

function emptyGrantSummary(): AccessGrantSummary {
  return { agents: [], skills: [], mcpServers: [], tools: [], capabilities: [], permissions: [], environments: [] }
}

function mergeGrantSummaries(left: AccessGrantSummary, right: AccessGrantSummary): AccessGrantSummary {
  left.agents.push(...right.agents)
  left.skills.push(...right.skills)
  left.mcpServers.push(...right.mcpServers)
  left.tools.push(...right.tools)
  left.capabilities.push(...right.capabilities)
  left.permissions.push(...right.permissions)
  left.environments.push(...right.environments)
  return sortGrantSummary(left)
}

function sortGrantSummary(grants: AccessGrantSummary): AccessGrantSummary {
  grants.agents = [...new Set(grants.agents)].sort()
  grants.skills = [...new Set(grants.skills)].sort()
  grants.mcpServers = [...new Set(grants.mcpServers)].sort()
  grants.tools = [...new Set(grants.tools)].sort()
  grants.capabilities = [...new Set(grants.capabilities)].sort()
  grants.permissions = grants.permissions
    .filter((row, index, rows) => rows.findIndex(other => other.key === row.key && other.policy === row.policy) === index)
    .sort((a, b) => a.key.localeCompare(b.key) || a.policy.localeCompare(b.policy))
  grants.environments = grants.environments.sort((a, b) => a.name.localeCompare(b.name))
  return grants
}

function rejection(code: string, path: string, message: string, action: string): TeamAssemblyRejection {
  return { code, path, message, action }
}

function blueprintIssueRejection(issue: BlueprintValidationIssue): TeamAssemblyRejection {
  return rejection(`blueprint_${issue.code}`, issue.path, issue.message, 'Fix the blueprint validation issue before requesting team assembly.')
}

function uniqueRejections(rejections: TeamAssemblyRejection[]): TeamAssemblyRejection[] {
  const seen = new Set<string>()
  return rejections.filter(row => {
    const key = `${row.code}:${row.path}:${row.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code))
}

function stageSort(a: string, b: string): number {
  const order = ['default', 'plan', 'implement', 'review', 'verify', 'audit']
  const ai = order.indexOf(a)
  const bi = order.indexOf(b)
  if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi) || a.localeCompare(b)
  return a.localeCompare(b)
}

function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${shortHash(stableStringify(parts))}`
}

function shortHash(value: unknown): string {
  return createHash('sha256').update(typeof value === 'string' ? value : stableStringify(value)).digest('hex').slice(0, 16)
}
