import type {
  ConfiguredTool,
  OpenCoworkConfig,
} from '@open-cowork/shared'
import {
  expandMcpToolPermissionPatterns,
} from '@open-cowork/runtime-host/config'
import {
  buildPermissionConfig,
  type PermissionActionConfig,
  type PermissionConfig,
  type PermissionObjectConfig,
  type PermissionRuleConfig,
} from '@open-cowork/runtime-host/permission-config'
import type { OpencodeRuntimeConfig } from '@open-cowork/runtime-host/runtime-config-builder'
import type { CloudRuntimePolicy } from './cloud-config.ts'

type CloudRuntimeCapabilityPolicyErrorCode =
  | 'unknown_tool'
  | 'unknown_mcp'

export class CloudRuntimeCapabilityPolicyError extends Error {
  readonly capabilityId: string
  readonly code: CloudRuntimeCapabilityPolicyErrorCode

  constructor(
    capabilityId: string,
    code: CloudRuntimeCapabilityPolicyErrorCode,
  ) {
    const kind = code === 'unknown_tool' ? 'tool' : 'MCP'
    super(`Cloud runtime policy references unknown ${kind} capability "${capabilityId}".`)
    this.name = 'CloudRuntimeCapabilityPolicyError'
    this.capabilityId = capabilityId
    this.code = code
  }
}

export type CompiledCloudRuntimeCapabilityPolicy = {
  allowedToolIds: readonly string[]
  allowedMcpNames: readonly string[]
  permission: PermissionConfig
}

const DEFAULT_NATIVE_TOOL_IDS = [
  'bash',
  'edit',
  'web',
  'read',
  'question',
  'skill',
  'task',
  'todowrite',
] as const

const NATIVE_TOOL_EXPANSIONS = {
  bash: ['bash'],
  edit: ['edit', 'write', 'apply_patch'],
  write: ['write'],
  apply_patch: ['apply_patch'],
  web: ['codesearch', 'webfetch', 'websearch'],
  codesearch: ['codesearch'],
  webfetch: ['webfetch'],
  websearch: ['websearch'],
  read: ['read', 'grep', 'glob', 'list', 'lsp'],
  grep: ['grep'],
  glob: ['glob'],
  list: ['list'],
  lsp: ['lsp'],
  skill: ['skill'],
  task: ['task'],
  todowrite: ['todowrite'],
  question: ['question'],
} as const

type NativeToolId = keyof typeof NATIVE_TOOL_EXPANSIONS
type NativePermissionKey = typeof NATIVE_TOOL_EXPANSIONS[NativeToolId][number]
type AgentPermissionConfig = Record<string, PermissionRuleConfig>

const PERMISSION_ACTION_RANK: Record<PermissionActionConfig, number> = {
  deny: 0,
  ask: 1,
  allow: 2,
}

function unique(values: readonly string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

function toolAllowPatterns(tool: ConfiguredTool) {
  if (tool.allowPatterns?.length) {
    return expandMcpToolPermissionPatterns([...tool.allowPatterns])
  }
  if (tool.patterns?.length) {
    return expandMcpToolPermissionPatterns([...tool.patterns])
  }
  return tool.namespace
    ? expandMcpToolPermissionPatterns([`mcp__${tool.namespace}__*`])
    : []
}

function toolAskPatterns(tool: ConfiguredTool) {
  return expandMcpToolPermissionPatterns([...(tool.askPatterns || [])])
}

function toolPatterns(tool: ConfiguredTool) {
  return unique([
    ...toolAllowPatterns(tool),
    ...toolAskPatterns(tool),
    ...expandMcpToolPermissionPatterns([...(tool.patterns || [])]),
  ])
}

function resolveAllowedMcpNames(
  appConfig: OpenCoworkConfig,
  policy: Pick<CloudRuntimePolicy, 'allowedMcps'>,
) {
  const configuredNames = new Set(appConfig.mcps.map((mcp) => mcp.name))
  const requested = policy.allowedMcps === null
    ? [...configuredNames]
    : unique(policy.allowedMcps)
  for (const name of requested) {
    if (!configuredNames.has(name)) {
      throw new CloudRuntimeCapabilityPolicyError(name, 'unknown_mcp')
    }
  }
  return requested
}

function resolveAllowedTools(
  appConfig: OpenCoworkConfig,
  policy: Pick<CloudRuntimePolicy, 'allowedTools'>,
) {
  const configuredIds = new Set(appConfig.tools.map((tool) => tool.id))
  const requested = policy.allowedTools === null
    ? [
        ...DEFAULT_NATIVE_TOOL_IDS,
        ...configuredIds,
      ]
    : unique(policy.allowedTools)
  for (const id of requested) {
    if (
      !configuredIds.has(id)
      && !(id in NATIVE_TOOL_EXPANSIONS)
    ) {
      throw new CloudRuntimeCapabilityPolicyError(id, 'unknown_tool')
    }
  }
  return requested
}

function resolveNativePermissionKeys(allowedToolIds: readonly string[]) {
  const permissionKeys = new Set<NativePermissionKey>()
  for (const id of allowedToolIds) {
    const keys = NATIVE_TOOL_EXPANSIONS[id as NativeToolId]
    for (const key of keys || []) permissionKeys.add(key)
  }
  return permissionKeys
}

function isPermissionAction(value: unknown): value is PermissionActionConfig {
  return value === 'deny' || value === 'ask' || value === 'allow'
}

function permissionPatternMatches(pattern: string, value: string) {
  let patternIndex = 0
  let valueIndex = 0
  let starIndex = -1
  let resumeValueIndex = 0

  while (valueIndex < value.length) {
    if (
      pattern[patternIndex] === '?'
      || pattern[patternIndex] === value[valueIndex]
    ) {
      patternIndex += 1
      valueIndex += 1
    } else if (pattern[patternIndex] === '*') {
      starIndex = patternIndex
      patternIndex += 1
      resumeValueIndex = valueIndex
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      resumeValueIndex += 1
      valueIndex = resumeValueIndex
    } else {
      return false
    }
  }

  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

function simplePrefixPattern(pattern: string): string | null {
  if (pattern === '*') return ''
  const starIndex = pattern.indexOf('*')
  if (starIndex === -1) return pattern.includes('?') ? null : pattern
  if (
    starIndex !== pattern.length - 1
    || pattern.indexOf('*', starIndex + 1) !== -1
    || pattern.includes('?')
  ) {
    return null
  }
  return pattern.slice(0, -1)
}

function permissionPatternCovers(ceilingPattern: string, candidatePattern: string) {
  if (ceilingPattern === candidatePattern || ceilingPattern === '*') return true
  if (!candidatePattern.includes('*') && !candidatePattern.includes('?')) {
    return permissionPatternMatches(ceilingPattern, candidatePattern)
  }

  const ceilingPrefix = simplePrefixPattern(ceilingPattern)
  const candidatePrefix = simplePrefixPattern(candidatePattern)
  return ceilingPrefix !== null
    && candidatePrefix !== null
    && candidatePrefix.startsWith(ceilingPrefix)
}

function permissionPatternsOverlap(left: string, right: string) {
  if (!left.includes('*') && !left.includes('?')) {
    return permissionPatternMatches(right, left)
  }
  if (!right.includes('*') && !right.includes('?')) {
    return permissionPatternMatches(left, right)
  }

  const leftPrefix = simplePrefixPattern(left)
  const rightPrefix = simplePrefixPattern(right)
  if (leftPrefix !== null && rightPrefix !== null) {
    return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix)
  }

  // Cloud-owned patterns are exact or trailing-star patterns. Treat an
  // unfamiliar pair as overlapping so an extension cannot widen the ceiling.
  return true
}

function clampPermissionAction(
  requested: PermissionActionConfig,
  ceiling: PermissionActionConfig,
) {
  return PERMISSION_ACTION_RANK[requested] <= PERMISSION_ACTION_RANK[ceiling]
    ? requested
    : ceiling
}

function permissionCeilingForPattern(
  permissionPattern: string,
  ceiling: PermissionObjectConfig,
): PermissionActionConfig {
  let action: PermissionActionConfig = 'deny'
  let covered = false

  // OpenCode converts config objects to rules in insertion order and uses the
  // last matching rule. A rule that covers the whole candidate domain resets
  // its ceiling. A later partially overlapping restriction lowers the ceiling
  // for the whole emitted agent rule; that conservative collapse is necessary
  // because config objects cannot express arbitrary glob intersections.
  for (const [ceilingPattern, rawAction] of Object.entries(ceiling)) {
    const next = isPermissionAction(rawAction) ? rawAction : 'deny'
    if (permissionPatternCovers(ceilingPattern, permissionPattern)) {
      action = next
      covered = true
      continue
    }
    if (
      covered
      && permissionPatternsOverlap(ceilingPattern, permissionPattern)
      && PERMISSION_ACTION_RANK[next] < PERMISSION_ACTION_RANK[action]
    ) {
      action = next
    }
  }

  return covered ? action : 'deny'
}

type AppliedAgentRule = {
  permissionPattern: string
  resourcePattern: string
  action: PermissionActionConfig
}

function priorRestrictionOverlaps(
  rules: readonly AppliedAgentRule[],
  permissionPattern: string,
  resourcePattern: string,
) {
  return rules.some((rule) => (
    rule.action !== 'allow'
    && permissionPatternsOverlap(rule.permissionPattern, permissionPattern)
    && permissionPatternsOverlap(rule.resourcePattern, resourcePattern)
  ))
}

function clampAgentPermission(
  permission: unknown,
  ceiling: PermissionObjectConfig,
): AgentPermissionConfig {
  if (!permission || typeof permission !== 'object' || Array.isArray(permission)) {
    return {}
  }

  const result: AgentPermissionConfig = {}
  const appliedRules: AppliedAgentRule[] = []
  const applyRule = (
    permissionPattern: string,
    resourcePattern: string,
    requested: PermissionActionConfig,
  ) => {
    // An allow with no earlier agent restriction is neutral: the preceding
    // global Cloud rules already grant everything the ceiling permits. Omitting
    // it avoids a broad agent wildcard overriding a narrower Cloud deny/ask.
    if (
      requested === 'allow'
      && !priorRestrictionOverlaps(
        appliedRules,
        permissionPattern,
        resourcePattern,
      )
    ) {
      return null
    }
    const action = clampPermissionAction(
      requested,
      permissionCeilingForPattern(permissionPattern, ceiling),
    )
    appliedRules.push({ permissionPattern, resourcePattern, action })
    return action
  }

  for (const [permissionPattern, rawRule] of Object.entries(
    permission as Record<string, unknown>,
  )) {
    if (isPermissionAction(rawRule)) {
      const action = applyRule(permissionPattern, '*', rawRule)
      if (action) result[permissionPattern] = action
      continue
    }
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) {
      // Config parsing should reject this before composition. If an unchecked
      // caller reaches the boundary, do not manufacture an agent grant.
      continue
    }

    const resourceRules: PermissionObjectConfig = {}
    for (const [resourcePattern, rawAction] of Object.entries(rawRule)) {
      if (!isPermissionAction(rawAction)) continue
      const action = applyRule(permissionPattern, resourcePattern, rawAction)
      if (action) resourceRules[resourcePattern] = action
    }
    if (Object.keys(resourceRules).length > 0) {
      result[permissionPattern] = resourceRules
    }
  }

  return result
}

export function compileCloudRuntimeCapabilityPolicy(input: {
  appConfig: OpenCoworkConfig
  policy: Pick<CloudRuntimePolicy, 'allowedTools' | 'allowedMcps'>
}): CompiledCloudRuntimeCapabilityPolicy {
  const allowedMcpNames = resolveAllowedMcpNames(input.appConfig, input.policy)
  const allowedMcpSet = new Set(allowedMcpNames)
  const allowedToolIds = resolveAllowedTools(input.appConfig, input.policy)
  const allowedToolSet = new Set(allowedToolIds)
  const nativePermissionKeys = resolveNativePermissionKeys(allowedToolIds)

  const selectedTools = input.appConfig.tools.filter((tool) => (
    allowedToolSet.has(tool.id)
    && (!tool.namespace || allowedMcpSet.has(tool.namespace))
  ))
  const selectedToolIds = new Set(selectedTools.map((tool) => tool.id))
  const effectiveAllowedToolIds = allowedToolIds.filter((id) => (
    id in NATIVE_TOOL_EXPANSIONS || selectedToolIds.has(id)
  ))
  const deniedTools = input.appConfig.tools.filter((tool) => !selectedTools.includes(tool))

  const allowPatterns = unique(selectedTools.flatMap(toolAllowPatterns))
  const askPatterns = unique(selectedTools.flatMap(toolAskPatterns))
  const deniedPatterns = unique(deniedTools.flatMap(toolPatterns))
  const appPermissions = input.appConfig.permissions
  const allowWeb = nativePermissionKeys.has('codesearch')
    || nativePermissionKeys.has('webfetch')
    || nativePermissionKeys.has('websearch')
  const allowEdit = nativePermissionKeys.has('edit')
    || nativePermissionKeys.has('write')
    || nativePermissionKeys.has('apply_patch')

  const builtPermission = buildPermissionConfig({
    allowPatterns,
    askPatterns,
    deniedPatterns,
    question: nativePermissionKeys.has('question') ? 'allow' : 'deny',
    task: nativePermissionKeys.has('task') ? appPermissions.task : 'deny',
    todoWrite: nativePermissionKeys.has('todowrite') ? 'allow' : 'deny',
    web: allowWeb ? appPermissions.web : 'deny',
    webSearch: nativePermissionKeys.has('websearch') && appPermissions.webSearch
      ? appPermissions.web
      : 'deny',
    bash: nativePermissionKeys.has('bash') ? appPermissions.bash : 'deny',
    edit: allowEdit ? appPermissions.fileWrite : 'deny',
  }) as PermissionObjectConfig
  // OpenCode's native default is permissive and MCP/custom tool ids are open
  // ended. Put the catch-all first so the later explicit native and MCP rules
  // are the only capabilities that can widen it (OpenCode uses last-match-wins
  // ordering for permission patterns).
  const permission: PermissionObjectConfig = {
    '*': 'deny',
    ...builtPermission,
  }

  permission.codesearch = nativePermissionKeys.has('codesearch') ? appPermissions.web : 'deny'
  permission.webfetch = nativePermissionKeys.has('webfetch') ? appPermissions.web : 'deny'
  permission.websearch = nativePermissionKeys.has('websearch') && appPermissions.webSearch
    ? appPermissions.web
    : 'deny'
  permission.edit = nativePermissionKeys.has('edit') ? appPermissions.fileWrite : 'deny'
  permission.write = nativePermissionKeys.has('write') ? appPermissions.fileWrite : 'deny'
  permission.apply_patch = nativePermissionKeys.has('apply_patch') ? appPermissions.fileWrite : 'deny'
  permission.read = nativePermissionKeys.has('read') ? 'allow' : 'deny'
  permission.grep = nativePermissionKeys.has('grep') ? 'allow' : 'deny'
  permission.glob = nativePermissionKeys.has('glob') ? 'allow' : 'deny'
  permission.list = nativePermissionKeys.has('list') ? 'allow' : 'deny'
  permission.lsp = nativePermissionKeys.has('lsp') ? 'allow' : 'deny'
  permission.skill = nativePermissionKeys.has('skill') ? 'allow' : 'deny'

  return {
    allowedToolIds: effectiveAllowedToolIds,
    allowedMcpNames,
    permission,
  }
}

export function applyCloudRuntimeCapabilityPolicy(
  config: OpencodeRuntimeConfig,
  compiled: CompiledCloudRuntimeCapabilityPolicy,
): OpencodeRuntimeConfig {
  const allowedMcpNames = new Set(compiled.allowedMcpNames)
  const mcp = Object.fromEntries(
    Object.entries(config.mcp || {}).filter(([name]) => allowedMcpNames.has(name)),
  )
  const agent = config.agent && Object.fromEntries(
    Object.entries(config.agent).map(([name, definition]) => [
      name,
      {
        ...definition,
        // OpenCode appends an agent's rules after the global ruleset. Retain
        // composition-owned restrictions at that later layer, but clamp every
        // rule so an agent cannot widen the Cloud capability ceiling.
        permission: clampAgentPermission(
          definition?.permission,
          compiled.permission as PermissionObjectConfig,
        ),
      },
    ]),
  )
  return {
    ...config,
    permission: compiled.permission,
    mcp,
    ...(agent ? { agent } : {}),
  }
}

export function isCloudRuntimeCapabilityAllowed(
  compiled: CompiledCloudRuntimeCapabilityPolicy,
  input: { toolId?: string | null, mcpName?: string | null },
) {
  if (input.toolId && !compiled.allowedToolIds.includes(input.toolId)) return false
  if (input.mcpName && !compiled.allowedMcpNames.includes(input.mcpName)) return false
  return true
}
