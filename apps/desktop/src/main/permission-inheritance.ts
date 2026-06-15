export type PermissionInheritanceAction = 'deny' | 'ask' | 'allow'

export interface PermissionInheritanceAgentConfig {
  mode?: string
  permission?: Record<string, unknown>
}

export type SensitivePermissionKey =
  | 'bash'
  | 'edit'
  | 'write'
  | 'apply_patch'
  | 'codesearch'
  | 'webfetch'
  | 'websearch'
  | 'todowrite'
  | 'external_directory'
  | 'mcp__*'
  | 'task'

export interface AgentPermissionMatrixEntry {
  agentName: string
  mode: string | undefined
  sensitive: Record<SensitivePermissionKey, PermissionInheritanceAction>
  taskTargets: Record<string, PermissionInheritanceAction>
}

export interface PermissionInheritanceIssue {
  parentAgent: string
  childAgent: string
  key: SensitivePermissionKey
  parentAction: PermissionInheritanceAction
  childAction: PermissionInheritanceAction
  reasonCode:
    | 'delegated-agent-missing'
    | 'child-more-permissive-than-parent'
}

const ACTION_RANK: Record<PermissionInheritanceAction, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

const SENSITIVE_KEYS: SensitivePermissionKey[] = [
  'bash',
  'edit',
  'write',
  'apply_patch',
  'codesearch',
  'webfetch',
  'websearch',
  'todowrite',
  'external_directory',
  'mcp__*',
  'task',
]

function normalizeAction(value: unknown): PermissionInheritanceAction {
  return value === 'allow' || value === 'ask' || value === 'deny' ? value : 'deny'
}

function maxAction(actions: PermissionInheritanceAction[]): PermissionInheritanceAction {
  return actions.reduce((current, next) => (
    ACTION_RANK[next] > ACTION_RANK[current] ? next : current
  ), 'deny' as PermissionInheritanceAction)
}

function permissionObjectActions(value: unknown): PermissionInheritanceAction[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['deny']
  return Object.values(value).map((entry) => normalizeAction(entry))
}

function sensitiveAction(permission: Record<string, unknown> | undefined, key: SensitivePermissionKey): PermissionInheritanceAction {
  if (!permission) return 'deny'
  const value = permission[key]
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return maxAction(permissionObjectActions(value))
  }
  return normalizeAction(value)
}

function taskTargetActions(permission: Record<string, unknown> | undefined): Record<string, PermissionInheritanceAction> {
  const value = permission?.task
  if (value === 'allow' || value === 'ask') return { '*': value }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const actions: Record<string, PermissionInheritanceAction> = {}
  for (const [target, action] of Object.entries(value)) {
    if (target === '*') continue
    actions[target] = normalizeAction(action)
  }
  return actions
}

function targetDelegationAction(entry: AgentPermissionMatrixEntry, childAgent: string): PermissionInheritanceAction {
  return entry.taskTargets[childAgent] || entry.taskTargets['*'] || 'deny'
}

export function buildAgentPermissionMatrix(agents: Record<string, PermissionInheritanceAgentConfig>): AgentPermissionMatrixEntry[] {
  return Object.entries(agents)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agentName, agent]) => {
      const permission = agent.permission
      const sensitive = Object.fromEntries(
        SENSITIVE_KEYS.map((key) => [key, sensitiveAction(permission, key)]),
      ) as Record<SensitivePermissionKey, PermissionInheritanceAction>
      return {
        agentName,
        mode: agent.mode,
        sensitive,
        taskTargets: taskTargetActions(permission),
      }
    })
}

export function findPermissionInheritanceIssues(agents: Record<string, PermissionInheritanceAgentConfig>): PermissionInheritanceIssue[] {
  const matrix = buildAgentPermissionMatrix(agents)
  const byName = new Map(matrix.map((entry) => [entry.agentName, entry]))
  const issues: PermissionInheritanceIssue[] = []

  for (const parent of matrix) {
    for (const [childAgent, action] of Object.entries(parent.taskTargets)) {
      if (action === 'deny') continue
      if (childAgent === '*') continue
      const child = byName.get(childAgent)
      if (!child) {
        issues.push({
          parentAgent: parent.agentName,
          childAgent,
          key: 'task',
          parentAction: action,
          childAction: 'deny',
          reasonCode: 'delegated-agent-missing',
        })
        continue
      }

      const parentDelegationAction = targetDelegationAction(parent, childAgent)
      for (const key of SENSITIVE_KEYS) {
        const parentAction = key === 'task' ? parentDelegationAction : parent.sensitive[key]
        const childAction = child.sensitive[key]
        if (ACTION_RANK[childAction] > ACTION_RANK[parentAction]) {
          issues.push({
            parentAgent: parent.agentName,
            childAgent,
            key,
            parentAction,
            childAction,
            reasonCode: 'child-more-permissive-than-parent',
          })
        }
      }
    }
  }

  return issues
}

export function assertPermissionInheritanceSafe(agents: Record<string, PermissionInheritanceAgentConfig>) {
  const issues = findPermissionInheritanceIssues(agents)
  if (issues.length > 0) {
    throw new Error(`Delegated permission inheritance regression: ${JSON.stringify(issues)}`)
  }
}

export function remoteApprovalFixtureMatrix() {
  return [
    {
      authority: 'desktop-local',
      permissionApproval: 'local-confirmation',
      questionReply: 'local-confirmation',
    },
    {
      authority: 'paired-desktop',
      permissionApproval: 'paired-local-confirmation',
      questionReply: 'paired-local-confirmation',
    },
    {
      authority: 'cloud-web',
      permissionApproval: 'cloud-rbac',
      questionReply: 'cloud-rbac',
    },
    {
      authority: 'cloud-channel-gateway',
      permissionApproval: 'gateway-actor-rbac',
      questionReply: 'gateway-actor-rbac',
    },
  ] as const
}
