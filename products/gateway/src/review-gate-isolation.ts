import type { AgentProfile, GatewayConfig, ReviewGateIsolationConfig } from './config.js'

type PermissionDecision = 'allow' | 'ask' | 'deny'
type EffectivePermissionMap = Record<string, PermissionDecision | Record<string, PermissionDecision>>

export interface ReviewGateIsolationDecision {
  active: boolean
  stage: string
  profileName: string
  profile: AgentProfile
  effectivePermission: EffectivePermissionMap
  deniedTools: string[]
  allowedBashCommands: string[]
  forbiddenPathHints: string[]
  changedPermissions: string[]
  promptContext: string
}

export function resolveReviewGateIsolation(input: {
  stage: string
  profileName: string
  profile: AgentProfile
  config: GatewayConfig
}): ReviewGateIsolationDecision {
  const policy = input.config.scheduler.reviewGateIsolation
  if (!policy.enabled || !policy.stages.includes(input.stage)) {
    return {
      active: false,
      stage: input.stage,
      profileName: input.profileName,
      profile: input.profile,
      effectivePermission: clonePermission(input.profile.permission),
      deniedTools: [],
      allowedBashCommands: [],
      forbiddenPathHints: [],
      changedPermissions: [],
      promptContext: '',
    }
  }

  const permission = clonePermission(input.profile.permission)
  const changedPermissions: string[] = []
  for (const tool of policy.deniedTools) {
    if (permissionDecision(permission[tool]) !== 'deny') changedPermissions.push(tool)
    permission[tool] = 'deny'
  }

  const bashPermission = bashPermissionForPolicy(policy)
  if (JSON.stringify(permission['bash']) !== JSON.stringify(bashPermission)) changedPermissions.push('bash')
  permission['bash'] = bashPermission

  const deniedTools = [...new Set([...policy.deniedTools, policy.allowBashEvidenceCommands ? undefined : 'bash'].filter(Boolean) as string[])].sort()
  const allowedBashCommands = policy.allowBashEvidenceCommands ? [...policy.bashAllowlist] : []
  return {
    active: true,
    stage: input.stage,
    profileName: input.profileName,
    profile: input.profile,
    effectivePermission: permission,
    deniedTools,
    allowedBashCommands,
    forbiddenPathHints: [...policy.forbiddenPathHints],
    changedPermissions: [...new Set(changedPermissions)].sort(),
    promptContext: formatIsolationPrompt({ stage: input.stage, deniedTools, allowedBashCommands, forbiddenPathHints: policy.forbiddenPathHints }),
  }
}

function bashPermissionForPolicy(policy: ReviewGateIsolationConfig): PermissionDecision | Record<string, PermissionDecision> {
  if (!policy.allowBashEvidenceCommands) return 'deny'
  const allowlist: Record<string, PermissionDecision> = { '': 'deny' }
  for (const command of policy.bashAllowlist) allowlist[command] = 'allow'
  return allowlist
}

function permissionDecision(value: EffectivePermissionMap[string] | undefined): PermissionDecision | undefined {
  return typeof value === 'string' ? value : undefined
}

function clonePermission(permission: Record<string, string>): EffectivePermissionMap {
  const output: EffectivePermissionMap = {}
  for (const [key, value] of Object.entries(permission || {})) {
    output[key] = value as PermissionDecision
  }
  return output
}

function formatIsolationPrompt(input: { stage: string; deniedTools: string[]; allowedBashCommands: string[]; forbiddenPathHints: string[] }): string {
  return [
    'Mechanical review-gate isolation policy is active for this stage.',
    `Stage: ${input.stage}`,
    `Denied capabilities: ${input.deniedTools.join(', ') || 'none'}.`,
    input.allowedBashCommands.length
      ? `Bash is restricted to approved evidence command prefixes only: ${input.allowedBashCommands.join('; ')}.`
      : 'Bash is denied.',
    `Forbidden context: ${input.forbiddenPathHints.join(', ') || 'none'}.`,
    'If required evidence cannot be collected inside this policy, return blocked with a specific next action instead of attempting a bypass.',
  ].join('\n')
}
