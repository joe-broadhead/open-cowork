import { createHash } from 'node:crypto'
import type { AgentBudgetContract, AgentProfile, AgentTeamConfig, GatewayConfig } from './config.js'
import {
  failClosedWarnings,
  inspectProfileAccess,
  inspectTeamAccess,
  type AccessInspection,
  type AccessInspectionKind,
  type AccessInspectionStatus,
  type AccessInspectionWarning,
  type OpenCodeAssetAvailability,
} from './access-inspection.js'
import { redactEnvironmentNetworkTarget, redactEnvironmentSensitiveText, type EnvironmentRunRecord, type EnvironmentSpec } from './environments.js'

export type RuntimeCapabilityGrantStatus = 'granted' | 'denied'
export type RuntimeCapabilityGrantDecision = 'allow' | 'ask' | 'deny'
export type RuntimeCapabilityGrantRequestKind = 'agent' | 'skill' | 'mcp' | 'tool' | 'capability' | 'permission' | 'environment' | 'secret' | 'network' | 'filesystem'

export interface RuntimeCapabilityGrantValidation {
  ok: boolean
  errors: string[]
  warnings: string[]
  denied: RuntimeCapabilityDenial[]
}

export interface RuntimeCapabilityDenial {
  kind: RuntimeCapabilityGrantRequestKind
  value: string
  reason: string
  action: string
}

export interface RuntimeCapabilityGrantInspectionSummary {
  kind: AccessInspectionKind
  name: string
  status: AccessInspectionStatus
  warnings: AccessInspectionWarning[]
  requirements: AccessInspection['requirements']
}

export interface RuntimeCapabilityGrant {
  version: 1
  id: string
  status: RuntimeCapabilityGrantStatus
  taskId: string
  stage: string
  profileName: string
  profileRevision: string
  agent?: string
  agentTeam?: {
    name: string
    revision?: string
    version?: string
  }
  source: string
  issuedAt: string
  expiresAt: string
  grants: {
    agent: string
    skills: string[]
    mcpServers: string[]
    tools: string[]
    capabilities: string[]
    permissions: Array<{ key: string; decision: RuntimeCapabilityGrantDecision }>
    environment: {
      name: string
      backend: EnvironmentSpec['backend']
      specHash: string
      runId?: string
    }
    filesystem: {
      workdir: string
      policy: 'local-workdir' | 'container-workspace' | 'remote-lease' | 'custom'
    }
    network: {
      mode: EnvironmentSpec['network']['mode']
      allow: string[]
    }
    secrets: {
      allowedNames: string[]
      count: number
    }
    budget: Required<Pick<AgentBudgetContract, 'maxTokens' | 'maxRuntimeMs'>> & Partial<AgentBudgetContract>
  }
  validation: RuntimeCapabilityGrantValidation
  inspections: {
    profile: RuntimeCapabilityGrantInspectionSummary
    team?: RuntimeCapabilityGrantInspectionSummary
  }
  redaction: {
    rawSecrets: 'excluded'
    secretValues: 'excluded'
    paths: 'redacted'
    providerTokens: 'excluded'
  }
}

export interface RuntimeCapabilityGrantSummary {
  id: string
  version: 1
  status: RuntimeCapabilityGrantStatus
  taskId: string
  stage: string
  profileName: string
  agent?: string
  agentTeam?: RuntimeCapabilityGrant['agentTeam']
  source: string
  issuedAt: string
  expiresAt: string
  grants: RuntimeCapabilityGrant['grants']
  validation: RuntimeCapabilityGrantValidation
  redaction: RuntimeCapabilityGrant['redaction']
}

export interface RuntimeCapabilityGrantInput {
  taskId: string
  stage: string
  profileName: string
  profile: AgentProfile
  profileRevision: string
  config: GatewayConfig
  agentTeamName?: string
  agentTeam?: AgentTeamConfig
  source: string
  effectivePermission: Record<string, unknown>
  environmentSpec: EnvironmentSpec
  environmentRun: EnvironmentRunRecord
  workdir?: string
  issuedAt?: Date
  now?: Date
  availability?: OpenCodeAssetAvailability
}



export function buildRuntimeCapabilityGrant(input: RuntimeCapabilityGrantInput): RuntimeCapabilityGrant {
  const now = input.now || new Date()
  const issuedAt = input.issuedAt || now
  const expiresAt = new Date(issuedAt.getTime() + grantTtlMs(input.profile, input.environmentRun, input.config)).toISOString()
  const profileInspection = inspectProfileAccess(input.profileName, input.profile, {
    config: input.config,
    availability: input.availability,
    now,
  })
  const teamInspection = input.agentTeam && input.agentTeamName
    ? inspectTeamAccess(input.agentTeamName, input.agentTeam, {
      config: input.config,
      availability: input.availability,
      now,
    })
    : undefined
  const validation = validateGrantInput(input, profileInspection, teamInspection, now, expiresAt)
  const grant: RuntimeCapabilityGrant = {
    version: 1,
    id: runtimeCapabilityGrantId(input.taskId, input.stage, input.profileName, input.profileRevision, input.agentTeam?.revision, input.environmentSpec.specHash, issuedAt.toISOString()),
    status: validation.ok ? 'granted' : 'denied',
    taskId: input.taskId,
    stage: input.stage,
    profileName: input.profileName,
    profileRevision: input.profileRevision,
    agent: input.profile.agent,
    agentTeam: input.agentTeamName ? { name: input.agentTeamName, revision: input.agentTeam?.revision, version: input.agentTeam?.version } : undefined,
    source: input.source,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
    grants: {
      agent: input.profile.agent,
      skills: uniqueStrings(input.profile.skills || []).sort(),
      mcpServers: uniqueStrings(input.profile.mcpServers || []).sort(),
      tools: uniqueStrings(input.profile.tools || []).sort(),
      capabilities: uniqueStrings(input.profile.capabilities || []).sort(),
      permissions: summarizePermissionMap(input.effectivePermission),
      environment: {
        name: input.environmentSpec.name,
        backend: input.environmentSpec.backend,
        specHash: input.environmentSpec.specHash,
        runId: input.environmentRun.id,
      },
      filesystem: {
        workdir: redactGrantText(input.workdir || input.environmentSpec.workdir || input.environmentRun.workdir || '(not set)'),
        policy: filesystemPolicy(input.environmentSpec),
      },
      network: {
        mode: input.environmentSpec.network.mode,
        allow: uniqueStrings((input.environmentSpec.network.allow || []).map(redactEnvironmentNetworkTarget)).sort(),
      },
      secrets: {
        allowedNames: uniqueStrings(input.environmentRun.secrets.allowedNames || []).sort(),
        count: input.environmentRun.secrets.allowedNames.length,
      },
      budget: summarizeBudget(input.profile, input.environmentRun, input.config),
    },
    validation,
    inspections: {
      profile: compactInspection(profileInspection),
      team: teamInspection ? compactInspection(teamInspection) : undefined,
    },
    redaction: {
      rawSecrets: 'excluded',
      secretValues: 'excluded',
      paths: 'redacted',
      providerTokens: 'excluded',
    },
  }
  return grant
}

export function summarizeRuntimeCapabilityGrant(grant: RuntimeCapabilityGrant | undefined): RuntimeCapabilityGrantSummary | undefined {
  if (!grant) return undefined
  return {
    id: grant.id,
    version: grant.version,
    status: grant.status,
    taskId: grant.taskId,
    stage: grant.stage,
    profileName: grant.profileName,
    agent: grant.agent,
    agentTeam: grant.agentTeam,
    source: grant.source,
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    grants: grant.grants,
    validation: grant.validation,
    redaction: grant.redaction,
  }
}

export function runtimeCapabilityGrantPromptContext(grant: RuntimeCapabilityGrant): string {
  return [
    'Runtime capability grant:',
    `- Grant: ${grant.id} (${grant.status})`,
    `- Profile: ${grant.profileName}${grant.agentTeam ? ` via team ${grant.agentTeam.name}` : ''}`,
    `- Agent: ${grant.grants.agent}`,
    grant.grants.skills.length ? `- Skills allowed: ${grant.grants.skills.join(', ')}` : '- Skills allowed: none',
    grant.grants.mcpServers.length ? `- MCP servers allowed: ${grant.grants.mcpServers.join(', ')}` : '- MCP servers allowed: none',
    grant.grants.tools.length ? `- Tools allowed: ${grant.grants.tools.join(', ')}` : '- Tools allowed: none declared',
    grant.grants.capabilities.length ? `- Capability labels: ${grant.grants.capabilities.join(', ')}` : '- Capability labels: none declared',
    `- Filesystem: ${grant.grants.filesystem.policy} ${grant.grants.filesystem.workdir}`,
    `- Network: ${grant.grants.network.mode}${grant.grants.network.allow.length ? ` allow=${grant.grants.network.allow.join(',')}` : ''}`,
    grant.grants.secrets.count ? `- Secret names allowed: ${grant.grants.secrets.allowedNames.join(', ')}` : '- Secret names allowed: none',
    `- Budget: maxTokens=${grant.grants.budget.maxTokens}; maxRuntimeMs=${grant.grants.budget.maxRuntimeMs}${grant.grants.budget.maxCostUsd !== undefined ? `; maxCostUsd=${grant.grants.budget.maxCostUsd}` : ''}`,
    '- Gateway does not bypass OpenCode-owned permission prompts; missing grants must be reported as blocked with a safe next action.',
  ].join('\n')
}

function validateGrantInput(
  input: RuntimeCapabilityGrantInput,
  profileInspection: AccessInspection,
  teamInspection: AccessInspection | undefined,
  now: Date,
  expiresAt: string,
): RuntimeCapabilityGrantValidation {
  const errors: string[] = []
  const warnings: string[] = []
  const denied: RuntimeCapabilityDenial[] = []
  const permissionValidation = validateEffectivePermission(input.effectivePermission)

  for (const row of failClosedWarnings(profileInspection)) {
    const message = `${row.code}: ${row.message}`
    errors.push(message)
    denied.push(denial('capability', row.path || row.subject, message, row.action))
  }
  if (teamInspection) {
    for (const row of failClosedWarnings(teamInspection)) {
      const message = `${row.code}: ${row.message}`
      errors.push(message)
      denied.push(denial('capability', row.path || row.subject, message, row.action))
    }
  }

  warnings.push(...profileInspection.warnings.filter(row => !row.failClosed && row.severity !== 'critical').map(row => `${row.code}: ${row.message}`))
  if (teamInspection) warnings.push(...teamInspection.warnings.filter(row => !row.failClosed && row.severity !== 'critical').map(row => `${row.code}: ${row.message}`))

  if (!input.profile.agent) errors.push('runtime capability grant requires a profile agent')
  if (!input.profile.skills?.length) warnings.push('runtime capability grant has no profile skills declared')
  if (!Object.keys(input.profile.permission || {}).length) errors.push('runtime capability grant requires an explicit profile permission map')
  if (!permissionValidation.ok) errors.push(...permissionValidation.errors)
  if (!input.environmentRun.preflight.ok) errors.push(`runtime capability grant cannot attach to failed preflight: ${input.environmentRun.preflight.missing.join(', ') || 'unknown tool'}`)
  if (now.getTime() > Date.parse(expiresAt)) {
    errors.push(`runtime capability grant expired before dispatch at ${expiresAt}`)
    denied.push(denial('capability', 'grant-expired', `runtime capability grant expired before dispatch at ${expiresAt}`, 'Resolve a fresh profile/team grant and retry dispatch.'))
  }

  return { ok: errors.length === 0, errors: uniqueStrings(errors).map(redactGrantText), warnings: uniqueStrings(warnings).map(redactGrantText), denied }
}

function validateEffectivePermission(permission: Record<string, unknown>): { ok: boolean; errors: string[] } {
  const errors: string[] = []
  for (const [key, value] of Object.entries(permission || {})) {
    if (typeof value === 'string') {
      if (!isDecision(value)) errors.push(`effective permission ${key || '(default)'} has invalid decision ${value}`)
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
        if (!isDecision(childValue)) errors.push(`effective permission ${key}.${childKey || '(default)'} has invalid decision ${String(childValue)}`)
      }
      continue
    }
    errors.push(`effective permission ${key || '(default)'} is malformed`)
  }
  return { ok: errors.length === 0, errors }
}

function summarizePermissionMap(permission: Record<string, unknown>): Array<{ key: string; decision: RuntimeCapabilityGrantDecision }> {
  const rows: Array<{ key: string; decision: RuntimeCapabilityGrantDecision }> = []
  for (const [key, value] of Object.entries(permission || {})) {
    if (typeof value === 'string' && isDecision(value)) {
      rows.push({ key: key || '(default)', decision: value })
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = Object.entries(value as Record<string, unknown>)
        .filter(([, decision]) => isDecision(decision))
        .map(([childKey, decision]) => `${childKey || '(default)'}:${decision}`)
        .sort()
        .join(',')
      rows.push({ key: key || '(default)', decision: nested.includes(':allow') ? 'ask' : nested.includes(':ask') ? 'ask' : 'deny' })
    }
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key) || a.decision.localeCompare(b.decision))
}

function summarizeBudget(profile: AgentProfile, environmentRun: EnvironmentRunRecord, config: GatewayConfig): RuntimeCapabilityGrant['grants']['budget'] {
  const maxRuntimeMs = positiveNumber(profile.budget?.maxRuntimeMs) || positiveNumber(config.governance.runtime.maxRunMs) || environmentRun.ttlMs
  return {
    maxTokens: positiveNumber(profile.budget?.maxTokens) || positiveNumber(profile.maxTokens) || 50_000,
    maxRuntimeMs,
    maxCostUsd: profile.budget?.maxCostUsd,
    retryLimit: profile.budget?.retryLimit ?? config.scheduler.retryLimit,
    humanGate: profile.budget?.humanGate,
  }
}

function grantTtlMs(profile: AgentProfile, environmentRun: EnvironmentRunRecord, config: GatewayConfig): number {
  return Math.max(1, summarizeBudget(profile, environmentRun, config).maxRuntimeMs)
}

function compactInspection(inspection: AccessInspection): RuntimeCapabilityGrantInspectionSummary {
  return {
    kind: inspection.kind,
    name: inspection.name,
    status: inspection.status,
    warnings: inspection.warnings,
    requirements: inspection.requirements,
  }
}

function filesystemPolicy(spec: EnvironmentSpec): RuntimeCapabilityGrant['grants']['filesystem']['policy'] {
  if (spec.backend === 'local-container') return 'container-workspace'
  if (spec.backend === 'remote-crabbox') return 'remote-lease'
  if (spec.backend === 'custom') return 'custom'
  return 'local-workdir'
}

function runtimeCapabilityGrantId(...parts: unknown[]): string {
  return `grant_${hash(JSON.stringify(parts)).slice(0, 16)}`
}

function denial(kind: RuntimeCapabilityGrantRequestKind, value: string, reason: string, action: string): RuntimeCapabilityDenial {
  return { kind, value: redactGrantText(value), reason: redactGrantText(reason), action: redactGrantText(action) }
}

function redactGrantText(value: string): string {
  return redactEnvironmentSensitiveText(String(value || ''))
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function isDecision(value: unknown): value is RuntimeCapabilityGrantDecision {
  return value === 'allow' || value === 'ask' || value === 'deny'
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))]
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value || 0)
  return Number.isFinite(number) && number > 0 ? number : undefined
}
