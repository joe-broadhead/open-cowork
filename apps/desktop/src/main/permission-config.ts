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
  bash?: PermissionActionConfig
  edit?: PermissionActionConfig
}): PermissionConfig {
  const webAccess: PermissionActionConfig = options.web || 'deny'
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
    websearch: webAccess,
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
  for (const pattern of options.deniedPatterns || []) permission[pattern] = 'deny'

  return permission
}
