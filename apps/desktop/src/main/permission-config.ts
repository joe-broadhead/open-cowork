import type {
  PermissionActionConfig,
  PermissionConfig,
  PermissionObjectConfig,
  PermissionRuleConfig,
} from '@opencode-ai/sdk/v2'
import { resolve, join } from 'path'
import { getProjectOverlayDirName } from './config-loader.ts'
import {
  getMachineSkillsDir,
  getRuntimeHomeDir,
  getRuntimeSkillCatalogDir,
} from './runtime-paths.ts'

export type PermissionAction = PermissionActionConfig
export type PermissionRuleMap = PermissionObjectConfig

export function buildManagedSkillRules(skillNames: string[]): PermissionRuleMap {
  return Object.fromEntries(
    Array.from(new Set(skillNames.filter(Boolean))).sort((a, b) => a.localeCompare(b)).map((name) => [name, 'allow' as const]),
  )
}

export function buildManagedExternalDirectoryRules(options: {
  skillNames: string[]
  projectDirectory?: string | null
}): PermissionRuleMap {
  const skillNames = Array.from(new Set(options.skillNames.filter(Boolean))).sort((a, b) => a.localeCompare(b))
  const rules: PermissionRuleMap = {}
  const machineSkillsDir = getMachineSkillsDir()
  const runtimeSkillCatalogDir = getRuntimeSkillCatalogDir()
  const runtimeReadableMirrorRoot = join(getRuntimeHomeDir(), getProjectOverlayDirName(), 'skill-bundles')
  const projectReadableMirrorRoot = options.projectDirectory
    ? join(resolve(options.projectDirectory), getProjectOverlayDirName(), 'skill-bundles')
    : null

  for (const skillName of skillNames) {
    rules[join(machineSkillsDir, skillName, '*')] = 'allow'
    rules[join(runtimeSkillCatalogDir, skillName, '*')] = 'allow'
    rules[join(runtimeReadableMirrorRoot, skillName, '*')] = 'allow'
    if (projectReadableMirrorRoot) {
      rules[join(projectReadableMirrorRoot, skillName, '*')] = 'allow'
    }
  }

  return rules
}

type NativePermissionActionKey =
  | 'codesearch'
  | 'webfetch'
  | 'websearch'
  | 'bash'
  | 'edit'
  | 'write'
  | 'apply_patch'

const PERMISSION_ACTION_RANK = {
  deny: 0,
  ask: 1,
  allow: 2,
} as const

type PermissionActionName = keyof typeof PERMISSION_ACTION_RANK

function isPermissionActionName(value: unknown): value is PermissionActionName {
  return value === 'deny' || value === 'ask' || value === 'allow'
}

function clampPermissionAction(existing: unknown, maximum: PermissionActionConfig): PermissionActionConfig {
  if (!isPermissionActionName(existing) || !isPermissionActionName(maximum)) return maximum
  return PERMISSION_ACTION_RANK[existing] <= PERMISSION_ACTION_RANK[maximum]
    ? existing as PermissionActionConfig
    : maximum
}

function permissionPatternMatches(pattern: string, toolId: string) {
  let patternIndex = 0
  let toolIndex = 0
  let starIndex = -1
  let resumeToolIndex = 0

  while (toolIndex < toolId.length) {
    const patternChar = pattern[patternIndex]
    if (patternChar === '?' || patternChar === toolId[toolIndex]) {
      patternIndex += 1
      toolIndex += 1
    } else if (patternChar === '*') {
      starIndex = patternIndex
      resumeToolIndex = toolIndex
      patternIndex += 1
    } else if (starIndex >= 0) {
      patternIndex = starIndex + 1
      resumeToolIndex += 1
      toolIndex = resumeToolIndex
    } else {
      return false
    }
  }

  while (pattern[patternIndex] === '*') patternIndex += 1
  return patternIndex === pattern.length
}

function requestedNativeAction(
  key: NativePermissionActionKey,
  askPatterns: string[] = [],
  allowPatterns: string[] = [],
): PermissionActionConfig | null {
  let action: PermissionActionConfig | null = null
  const apply = (next: PermissionActionName) => {
    if (!action || PERMISSION_ACTION_RANK[next] < PERMISSION_ACTION_RANK[action as PermissionActionName]) {
      action = next
    }
  }
  for (const pattern of askPatterns) {
    if (permissionPatternMatches(pattern, key)) apply('ask')
  }
  for (const pattern of allowPatterns) {
    if (permissionPatternMatches(pattern, key)) apply('allow')
  }
  return action
}

function setTrailingPermissionRule(
  permission: PermissionConfig,
  key: NativePermissionActionKey,
  value: PermissionActionConfig,
  requestedAction: PermissionActionConfig | null,
  requireRequestedAction: boolean,
) {
  const orderedRules = permission as PermissionConfig & Record<NativePermissionActionKey, PermissionActionConfig>
  delete orderedRules[key]
  if (requireRequestedAction && !requestedAction) {
    orderedRules[key] = 'deny'
    return
  }
  orderedRules[key] = clampPermissionAction(requestedAction, value)
}

export function buildPermissionConfig(options: {
  skillRules?: PermissionRuleMap
  allowAllSkills?: boolean
  externalDirectoryRules?: PermissionRuleMap
  toolPatternsToDeny?: string[]
  allowPatterns?: string[]
  askPatterns?: string[]
  // User-chosen per-tool denies, applied after allow/ask so a specific
  // pattern like `mcp__github__delete_repo` cannot be shadowed by the
  // MCP's wildcard allow. Distinct from `toolPatternsToDeny`, which is
  // the deny-everything registry written before allow/ask.
  deniedPatterns?: string[]
  question?: PermissionActionConfig
  task?: PermissionRuleConfig
  todoWrite?: PermissionActionConfig
  web?: PermissionActionConfig
  webSearch?: PermissionActionConfig
  bash?: PermissionActionConfig
  edit?: PermissionActionConfig
  requireNativeToolPattern?: boolean
}): PermissionConfig {
  const webAccess: PermissionActionConfig = options.web || 'deny'
  const webSearchAccess: PermissionActionConfig = options.webSearch || webAccess
  const editAccess: PermissionActionConfig = options.edit || 'deny'
  const permission: PermissionConfig = {
    skill: options.allowAllSkills
      ? 'allow'
      : {
          '*': 'deny',
          ...(options.skillRules || {}),
        },
    'mcp__*': 'deny',
    question: options.question || 'deny',
    task: typeof options.task === 'string'
      ? options.task
      : options.task
        ? { '*': 'deny', ...options.task }
        : 'deny',
    external_directory: options.externalDirectoryRules
      ? {
          '*': 'deny',
          ...options.externalDirectoryRules,
        }
      : 'deny',
    doom_loop: 'ask',
    todowrite: options.todoWrite || 'deny',
    codesearch: webAccess,
    webfetch: webAccess,
    websearch: webSearchAccess,
    lsp: 'allow',
    bash: options.bash || 'deny',
    edit: editAccess,
    write: editAccess,
    apply_patch: editAccess,
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
  }

  for (const pattern of options.toolPatternsToDeny || []) permission[pattern] = 'deny'
  for (const pattern of options.askPatterns || []) permission[pattern] = 'ask'
  for (const pattern of options.allowPatterns || []) permission[pattern] = 'allow'
  // App-level native tool policy wins over broad allow/ask pattern expansion.
  // Downstream builds must be able to turn off web/bash/write globally even
  // if a bundled agent still lists a native tool in its capability config.
  const requestedActionFor = (key: NativePermissionActionKey) =>
    requestedNativeAction(key, options.askPatterns, options.allowPatterns)
  setTrailingPermissionRule(permission, 'codesearch', webAccess, requestedActionFor('codesearch'), options.requireNativeToolPattern === true)
  setTrailingPermissionRule(permission, 'webfetch', webAccess, requestedActionFor('webfetch'), options.requireNativeToolPattern === true)
  setTrailingPermissionRule(permission, 'websearch', webSearchAccess, requestedActionFor('websearch'), options.requireNativeToolPattern === true)
  setTrailingPermissionRule(permission, 'bash', options.bash || 'deny', requestedActionFor('bash'), options.requireNativeToolPattern === true)
  setTrailingPermissionRule(permission, 'edit', editAccess, requestedActionFor('edit'), options.requireNativeToolPattern === true)
  setTrailingPermissionRule(permission, 'write', editAccess, requestedActionFor('write'), options.requireNativeToolPattern === true)
  setTrailingPermissionRule(permission, 'apply_patch', editAccess, requestedActionFor('apply_patch'), options.requireNativeToolPattern === true)
  for (const pattern of options.deniedPatterns || []) permission[pattern] = 'deny'

  return permission
}
