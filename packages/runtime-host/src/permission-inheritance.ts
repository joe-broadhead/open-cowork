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
  code:
    | 'permission-inheritance/delegated-agent-missing'
    | 'permission-inheritance/child-more-permissive-than-parent'
  path: string
  parentAgent: string
  childAgent: string
  key: SensitivePermissionKey
  parentAction: PermissionInheritanceAction
  childAction: PermissionInheritanceAction
  reasonCode:
    | 'delegated-agent-missing'
    | 'child-more-permissive-than-parent'
}

export interface PermissionInheritanceValidation {
  revision: string
  issues: PermissionInheritanceIssue[]
}

export interface PermissionInheritanceReport {
  revision: string
  summary: string
  issues: readonly PermissionInheritanceIssue[]
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

const MAX_REPORTED_PERMISSION_INHERITANCE_REVISIONS = 128

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

function taskTargetActions(
  permission: Record<string, unknown> | undefined,
  eligibleChildAgents: readonly string[],
): Record<string, PermissionInheritanceAction> {
  const value = permission?.task
  if (value === 'allow' || value === 'ask') {
    return Object.fromEntries(
      eligibleChildAgents.map((childAgent) => [childAgent, value]),
    )
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}

  const wildcardAction = normalizeAction((value as Record<string, unknown>)['*'])
  const actions = new Map<string, PermissionInheritanceAction>()
  if (wildcardAction === 'allow' || wildcardAction === 'ask') {
    for (const childAgent of eligibleChildAgents) {
      actions.set(
        childAgent,
        Object.hasOwn(value, childAgent)
          ? normalizeAction((value as Record<string, unknown>)[childAgent])
          : wildcardAction,
      )
    }
  }
  for (const [target, action] of Object.entries(value)) {
    if (target !== '*') actions.set(target, normalizeAction(action))
  }
  return Object.fromEntries(
    [...actions].sort(([left], [right]) => left.localeCompare(right)),
  )
}

function targetDelegationAction(entry: AgentPermissionMatrixEntry, childAgent: string): PermissionInheritanceAction {
  return entry.taskTargets[childAgent] || entry.taskTargets['*'] || 'deny'
}

export function buildAgentPermissionMatrix(agents: Record<string, PermissionInheritanceAgentConfig>): AgentPermissionMatrixEntry[] {
  const eligibleChildAgents = Object.entries(agents)
    .filter(([, agent]) => agent.mode === 'subagent')
    .map(([agentName]) => agentName)
    .sort((left, right) => left.localeCompare(right))

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
        taskTargets: taskTargetActions(
          permission,
          eligibleChildAgents.filter((childAgent) => childAgent !== agentName),
        ),
      }
    })
}

function permissionPath(agentName: string, key: SensitivePermissionKey) {
  return `agents[${JSON.stringify(agentName)}].permission[${JSON.stringify(key)}]`
}

function delegationPath(parentAgent: string, childAgent: string) {
  return `agents[${JSON.stringify(parentAgent)}].permission.task[${JSON.stringify(childAgent)}]`
}

function permissionInheritanceRevision(matrix: AgentPermissionMatrixEntry[]) {
  const source = JSON.stringify(matrix)
  let hash = 2166136261
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `permission-inheritance-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function findPermissionInheritanceIssuesFromMatrix(matrix: AgentPermissionMatrixEntry[]) {
  const byName = new Map(matrix.map((entry) => [entry.agentName, entry]))
  const issues: PermissionInheritanceIssue[] = []

  for (const parent of matrix) {
    for (const [childAgent, action] of Object.entries(parent.taskTargets)
      .sort(([left], [right]) => left.localeCompare(right))) {
      if (action === 'deny') continue
      if (childAgent === '*') continue
      const child = byName.get(childAgent)
      if (!child) {
        issues.push({
          code: 'permission-inheritance/delegated-agent-missing',
          path: delegationPath(parent.agentName, childAgent),
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
            code: 'permission-inheritance/child-more-permissive-than-parent',
            path: permissionPath(childAgent, key),
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

export function validatePermissionInheritance(
  agents: Record<string, PermissionInheritanceAgentConfig>,
): PermissionInheritanceValidation {
  const matrix = buildAgentPermissionMatrix(agents)
  return {
    revision: permissionInheritanceRevision(matrix),
    issues: findPermissionInheritanceIssuesFromMatrix(matrix),
  }
}

export function findPermissionInheritanceIssues(agents: Record<string, PermissionInheritanceAgentConfig>): PermissionInheritanceIssue[] {
  return validatePermissionInheritance(agents).issues
}

export function createPermissionInheritanceReporter(
  write: (report: PermissionInheritanceReport) => void,
) {
  const seenRevisions = new Set<string>()
  return {
    report(validation: PermissionInheritanceValidation) {
      if (seenRevisions.has(validation.revision)) return false
      if (seenRevisions.size >= MAX_REPORTED_PERMISSION_INHERITANCE_REVISIONS) {
        const oldestRevision = seenRevisions.values().next().value
        if (oldestRevision) seenRevisions.delete(oldestRevision)
      }
      seenRevisions.add(validation.revision)
      if (validation.issues.length === 0) return false
      write({
        revision: validation.revision,
        summary: `Delegated permission inheritance issues (${validation.issues.length}) for configuration revision ${validation.revision}.`,
        issues: validation.issues.map((issue) => ({ ...issue })),
      })
      return true
    },
  }
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
